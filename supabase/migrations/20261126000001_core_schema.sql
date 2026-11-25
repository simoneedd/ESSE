-- Personal OS - schema principale (progetto Supabase SEPARATO da IronEdge Growth OS)
-- Regole:
--  * ogni riga appartiene a un utente (user_id = auth.uid()), RLS forzata su ogni tabella;
--  * timestamp in UTC (timestamptz), date locali calcolate con il fuso del profilo;
--  * valori sconosciuti = NULL (mai 0 inventati);
--  * deduplica tramite vincoli UNIQUE (source + external_id, chiavi di idempotenza);
--  * dati sanitari/alimentari/sonno restano qui e NON vengono mai inviati a IronEdge.

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tipi enumerati
-- ---------------------------------------------------------------------------
create type public.life_area as enum ('personal', 'marketing', 'trading', 'ironedge', 'gym', 'study', 'health');
create type public.task_status as enum ('todo', 'in_progress', 'done', 'skipped', 'cancelled');
create type public.task_source as enum ('local', 'ironedge');
create type public.flexibility as enum ('fixed', 'flexible');
create type public.block_status as enum ('planned', 'done', 'partial', 'skipped', 'moved');
create type public.proposal_status as enum ('pending', 'approved', 'rejected', 'applied', 'expired');
create type public.meal_slot as enum ('breakfast', 'lunch', 'dinner', 'snack');
create type public.trading_kind as enum ('operative_session', 'market_analysis', 'chart_prep', 'macro_event', 'meeting', 'ironedge_activity', 'tiktok_live', 'webinar', 'lesson');
create type public.study_kind as enum ('course', 'subject', 'book');
create type public.sync_direction as enum ('pull', 'push');
create type public.sync_outcome as enum ('ok', 'conflict', 'error', 'skipped', 'duplicate');
create type public.outbox_status as enum ('pending', 'processing', 'done', 'failed', 'dead');
create type public.memory_kind as enum ('preference', 'decision', 'fact', 'constraint');
create type public.run_status as enum ('running', 'succeeded', 'failed', 'skipped');
create type public.notify_channel as enum ('in_app', 'telegram', 'push');

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profilo e impostazioni (1 riga per utente)
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key default auth.uid(),
  display_name text check (display_name is null or char_length(display_name) <= 80),
  timezone text not null default 'Europe/Rome',
  -- vincoli del sonno: il riposo e' prioritario, lo scheduler non lo comprime in automatico
  sleep_goal_minutes integer not null default 480 check (sleep_goal_minutes between 240 and 720),
  target_bedtime time not null default '23:30',
  target_wake time not null default '07:30',
  workday_start time not null default '09:00',
  workday_end time not null default '19:00',
  max_work_minutes_per_day integer not null default 540 check (max_work_minutes_per_day between 60 and 960),
  buffer_percent integer not null default 15 check (buffer_percent between 0 and 50),
  default_travel_minutes integer not null default 0 check (default_travel_minutes between 0 and 240),
  -- orari notifiche/briefing configurabili
  schedule jsonb not null default
    '{"morning_briefing":"07:45","evening_review":"21:30","bedtime_reminder_offset_min":45,"weekly_report_dow":7,"weekly_report":"18:00","monthly_report_day":1,"task_reminder_min":10}'::jsonb,
  -- autonomia dello scheduler: aree/categorie flessibili che puo' spostare senza chiedere
  auto_reschedule_areas public.life_area[] not null default array['study','personal']::public.life_area[],
  -- consenso esplicito all'invio di dati minimizzati al provider AI (default: no)
  ai_consent boolean not null default false,
  ai_share_health boolean not null default false,
  retention_days integer not null default 730 check (retention_days between 30 and 3650),
  telegram_chat_id bigint,
  telegram_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (telegram_chat_id is null or telegram_opt_in)
);

-- ---------------------------------------------------------------------------
-- Lavoro marketing: clienti e progetti
-- ---------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 120),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  priority smallint not null default 2 check (priority between 1 and 4),
  weekly_target_minutes integer check (weekly_target_minutes is null or weekly_target_minutes between 0 and 6000),
  contact_notes text check (contact_notes is null or char_length(contact_notes) <= 4000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  client_id uuid references public.clients(id) on delete cascade,
  area public.life_area not null default 'marketing',
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'archived')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_idx on public.projects(user_id, client_id);

-- ---------------------------------------------------------------------------
-- Task unificate (locali + sincronizzate da IronEdge)
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  area public.life_area not null default 'personal',
  client_id uuid references public.clients(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  description text check (description is null or char_length(description) <= 8000),
  priority smallint not null default 3 check (priority between 1 and 4), -- 1 = urgente
  due_at timestamptz,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 5 and 1440),
  status public.task_status not null default 'todo',
  category text check (category is null or char_length(category) <= 80),
  depends_on uuid[] not null default '{}',
  completed_at timestamptz,
  flexibility public.flexibility not null default 'flexible',
  -- null = segue profiles.auto_reschedule_areas; true/false = scelta esplicita per la task
  auto_reschedule boolean,
  recurrence text check (recurrence is null or recurrence in ('daily', 'weekdays', 'weekly', 'monthly')),
  -- sincronizzazione
  source public.task_source not null default 'local',
  external_id text,
  external_group_id text, -- es. id della task "modello" IronEdge di cui questa e' un'occorrenza
  external_url text check (external_url is null or external_url ~ '^https://'),
  external_version text,
  external_payload_hash text,
  last_synced_at timestamptz,
  local_dirty boolean not null default false,
  postponed_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source = 'local' or external_id is not null),
  check (status <> 'done' or completed_at is not null)
);
-- prevenzione duplicati: un solo record per task esterna e utente
create unique index tasks_external_uidx on public.tasks(user_id, source, external_id) where external_id is not null;
create index tasks_user_status_idx on public.tasks(user_id, status, due_at);

-- ---------------------------------------------------------------------------
-- Eventi (impegni fissi, riunioni, appuntamenti) e blocchi pianificati
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  area public.life_area not null default 'personal',
  client_id uuid references public.clients(id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  notes text check (notes is null or char_length(notes) <= 4000),
  location text check (location is null or char_length(location) <= 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  travel_before_minutes integer not null default 0 check (travel_before_minutes between 0 and 240),
  travel_after_minutes integer not null default 0 check (travel_after_minutes between 0 and 240),
  -- impegni con altre persone o esterni: ogni modifica richiede approvazione
  involves_others boolean not null default false,
  is_external boolean not null default false,
  flexibility public.flexibility not null default 'fixed',
  kind text not null default 'appointment' check (kind in ('appointment', 'meeting', 'personal', 'workout', 'study', 'trading', 'meal', 'sleep', 'other')),
  ref_table text check (ref_table is null or ref_table in ('workout_sessions', 'trading_sessions', 'study_sessions')),
  ref_id uuid,
  gcal_calendar_id text,
  gcal_event_id text,
  gcal_etag text,
  gcal_synced_at timestamptz,
  origin text not null default 'personal_os' check (origin in ('personal_os', 'google')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '24 hours')
);
create index events_user_time_idx on public.events(user_id, starts_at);
create unique index events_gcal_uidx on public.events(user_id, gcal_event_id) where gcal_event_id is not null;

create table public.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  plan_date date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  area public.life_area not null,
  kind text not null check (kind in ('task', 'event', 'meal', 'workout', 'study', 'trading', 'break', 'buffer', 'travel', 'sleep', 'wind_down')),
  title text not null check (char_length(title) between 1 and 200),
  task_id uuid references public.tasks(id) on delete set null,
  event_id uuid references public.events(id) on delete cascade,
  flexibility public.flexibility not null default 'flexible',
  status public.block_status not null default 'planned',
  actual_minutes integer check (actual_minutes is null or actual_minutes between 0 and 1440),
  plan_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index blocks_user_date_idx on public.schedule_blocks(user_id, plan_date);

-- Proposte di modifica che richiedono approvazione (impegni fissi, riunioni, esterni, ripianificazioni)
create table public.plan_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  kind text not null check (kind in ('move_event', 'reschedule_task', 'plan_day', 'add_workouts', 'reduce_load', 'other')),
  summary text not null check (char_length(summary) between 1 and 500),
  reason text check (reason is null or char_length(reason) <= 1000),
  payload jsonb not null default '{}'::jsonb,
  requires_approval boolean not null default true,
  status public.proposal_status not null default 'pending',
  created_by text not null default 'scheduler' check (created_by in ('scheduler', 'assistant', 'user')),
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index proposals_user_status_idx on public.plan_proposals(user_id, status);

-- Tempo effettivo (per confronto pianificato/effettivo e report)
create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  area public.life_area not null,
  client_id uuid references public.clients(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  block_id uuid references public.schedule_blocks(id) on delete set null,
  started_at timestamptz not null,
  minutes integer not null check (minutes between 1 and 1440),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index time_entries_user_idx on public.time_entries(user_id, started_at);

-- ---------------------------------------------------------------------------
-- Sonno
-- ---------------------------------------------------------------------------
create table public.sleep_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  night_of date not null,             -- data della sera in cui si va a dormire
  bedtime timestamptz,
  wake_time timestamptz,
  slept_minutes integer check (slept_minutes is null or slept_minutes between 0 and 1200),
  quality smallint check (quality is null or quality between 1 and 5),
  source text not null default 'manual' check (source in ('manual', 'import')),
  import_source text check (import_source is null or char_length(import_source) <= 60),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, night_of),
  check (wake_time is null or bedtime is null or wake_time > bedtime)
);

-- Sveglie pianificate: promemoria (notifica) distinti da sveglie native del dispositivo
create table public.wake_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  for_date date not null,
  wake_at timestamptz not null,
  bedtime_target timestamptz,
  -- 'reminder' = notifica Personal OS; 'calendar' = evento Google Calendar con avviso;
  -- 'native_manual' = l'utente imposta a mano la sveglia del telefono (Personal OS non puo' farlo)
  mechanism text not null default 'reminder' check (mechanism in ('reminder', 'calendar', 'native_manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, for_date)
);

-- ---------------------------------------------------------------------------
-- Alimentazione (nessuna prescrizione generata: solo piani importati dall'utente/professionista)
-- ---------------------------------------------------------------------------
create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 120),
  author text check (author is null or char_length(author) <= 120), -- es. "Dott.ssa X, nutrizionista"
  valid_from date,
  valid_to date,
  active boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'import_csv', 'import_json')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.meal_plan_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  plan_id uuid not null references public.meal_plans(id) on delete cascade,
  weekday smallint check (weekday is null or weekday between 1 and 7), -- null = tutti i giorni
  slot public.meal_slot not null,
  time_hint time,
  description text not null check (char_length(description) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  eaten_at timestamptz not null,
  slot public.meal_slot not null,
  description text not null check (char_length(description) between 1 and 1000),
  followed_plan boolean,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meal_logs_user_idx on public.meal_logs(user_id, eaten_at);

create table public.hydration_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  logged_at timestamptz not null default now(),
  ml integer not null check (ml between 1 and 3000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hydration_user_idx on public.hydration_logs(user_id, logged_at);

create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 120),
  quantity text check (quantity is null or char_length(quantity) <= 40),
  checked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Palestra
-- ---------------------------------------------------------------------------
create table public.workout_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 120),
  focus text check (focus is null or char_length(focus) <= 120),
  estimated_minutes integer not null default 60 check (estimated_minutes between 10 and 300),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.template_exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  template_id uuid not null references public.workout_templates(id) on delete cascade,
  position smallint not null default 0,
  exercise text not null check (char_length(exercise) between 1 and 120),
  sets smallint not null default 3 check (sets between 1 and 20),
  reps text not null default '10' check (char_length(reps) between 1 and 20), -- es. "8-10"
  load_kg numeric(6,2) check (load_kg is null or load_kg between 0 and 1000),
  rest_seconds integer check (rest_seconds is null or rest_seconds between 0 and 900),
  notes text check (notes is null or char_length(notes) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  template_id uuid references public.workout_templates(id) on delete set null,
  planned_for timestamptz,
  performed_at timestamptz,
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 400),
  status text not null default 'planned' check (status in ('planned', 'done', 'skipped', 'rest_day')),
  perceived_effort smallint check (perceived_effort is null or perceived_effort between 1 and 10),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workout_sessions_user_idx on public.workout_sessions(user_id, planned_for);

create table public.session_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  session_id uuid not null references public.workout_sessions(id) on delete cascade,
  exercise text not null check (char_length(exercise) between 1 and 120),
  set_number smallint not null check (set_number between 1 and 50),
  reps smallint check (reps is null or reps between 0 and 500),
  load_kg numeric(6,2) check (load_kg is null or load_kg between 0 and 1000),
  rest_seconds integer check (rest_seconds is null or rest_seconds between 0 and 900),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Trading (solo pianificazione: nessuna esecuzione di ordini, nessuna connessione a broker)
-- ---------------------------------------------------------------------------
create table public.trading_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  kind public.trading_kind not null,
  title text not null check (char_length(title) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  instrument text check (instrument is null or char_length(instrument) <= 40),
  notes text check (notes is null or char_length(notes) <= 4000),
  status text not null default 'planned' check (status in ('planned', 'done', 'skipped')),
  fixed boolean not null default false, -- es. dati macro, webinar con orario pubblico
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index trading_user_idx on public.trading_sessions(user_id, starts_at);

-- ---------------------------------------------------------------------------
-- Studio
-- ---------------------------------------------------------------------------
create table public.study_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  kind public.study_kind not null default 'course',
  title text not null check (char_length(title) between 1 and 200),
  author text check (author is null or char_length(author) <= 120),
  goal text check (goal is null or char_length(goal) <= 500),
  total_units integer check (total_units is null or total_units between 1 and 100000), -- lezioni/pagine/capitoli
  done_units integer not null default 0 check (done_units >= 0),
  weekly_target_minutes integer check (weekly_target_minutes is null or weekly_target_minutes between 0 and 6000),
  due_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_units is null or done_units <= total_units)
);

create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  item_id uuid references public.study_items(id) on delete set null,
  started_at timestamptz not null,
  focus_minutes integer not null check (focus_minutes between 1 and 600),
  break_minutes integer not null default 0 check (break_minutes between 0 and 300),
  pomodoros smallint check (pomodoros is null or pomodoros between 0 and 30),
  units_done integer check (units_done is null or units_done between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index study_sessions_user_idx on public.study_sessions(user_id, started_at);

create table public.study_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  item_id uuid references public.study_items(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  body text check (body is null or char_length(body) <= 20000),
  -- ripasso dilazionato (intervalli 1-3-7-14-30 giorni)
  review_stage smallint not null default 0 check (review_stage between 0 and 10),
  next_review_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Abitudini
-- ---------------------------------------------------------------------------
create table public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 80),
  area public.life_area not null default 'personal',
  target_per_week smallint not null default 7 check (target_per_week between 1 and 7),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.habit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  habit_id uuid not null references public.habits(id) on delete cascade,
  log_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (habit_id, log_date)
);

-- ---------------------------------------------------------------------------
-- Assistente: conversazioni, memoria persistente modificabile, uso AI
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null default 'Conversazione' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  engine text not null default 'rules' check (engine in ('rules', 'ai')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_messages_conv_idx on public.ai_messages(conversation_id, created_at);

create table public.assistant_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  kind public.memory_kind not null,
  content text not null check (char_length(content) between 1 and 1000),
  source text not null default 'user' check (source in ('user', 'assistant')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(10,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_usage_user_idx on public.ai_usage(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Integrazioni: IronEdge (sync), Google Calendar
-- ---------------------------------------------------------------------------
create table public.integration_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null check (provider in ('ironedge', 'google_calendar', 'telegram')),
  enabled boolean not null default false,
  cursor text,                -- cursore di sincronizzazione incrementale
  config jsonb not null default '{}'::jsonb, -- SOLO configurazione non segreta
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- Outbox: modifiche locali da propagare (es. completamento task IronEdge) con retry e backoff
create table public.sync_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null check (provider in ('ironedge', 'google_calendar')),
  operation text not null check (operation in ('set_status', 'upsert_event', 'delete_event')),
  entity_id uuid not null,
  payload jsonb not null,
  idempotency_key text not null,
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, idempotency_key)
);
create index sync_outbox_due_idx on public.sync_outbox(status, next_attempt_at);

-- Storico delle sincronizzazioni (senza contenuti personali: solo id, esito, conteggi)
create table public.sync_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  direction public.sync_direction not null,
  outcome public.sync_outcome not null,
  entity_id uuid,
  external_id text,
  detail text check (detail is null or char_length(detail) <= 500),
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sync_log_user_idx on public.sync_log(user_id, created_at desc);

-- Token OAuth Google: cifrati lato applicazione (AES-256-GCM), mai leggibili dal client
create table public.oauth_tokens (
  user_id uuid not null,
  provider text not null check (provider in ('google')),
  encrypted_refresh_token text not null,
  scopes text not null,
  account_hint text, -- es. iniziali/ dominio, mai il token
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table public.calendar_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  area public.life_area not null,
  gcal_calendar_id text not null check (char_length(gcal_calendar_id) between 3 and 300),
  read_enabled boolean not null default true,
  write_enabled boolean not null default false, -- scrittura solo se autorizzata esplicitamente
  sync_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, area)
);

-- ---------------------------------------------------------------------------
-- Notifiche, job, audit
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  channel public.notify_channel not null default 'in_app',
  kind text not null,
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) <= 4000),
  dedupe_key text not null,
  read_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('morning_briefing', 'evening_review', 'weekly', 'monthly')),
  period_start date not null,
  period_end date not null,
  content jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, period_start)
);

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  job text not null,
  idempotency_key text not null,
  status public.run_status not null default 'running',
  attempt integer not null default 1 check (attempt between 1 and 5),
  locked_until timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_redacted text,
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index job_runs_idem_idx on public.job_runs(coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), job, idempotency_key);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  actor text not null default 'user' check (actor in ('user', 'assistant', 'scheduler', 'sync', 'system')),
  action text not null,
  entity text not null,
  entity_id uuid,
  fields text[], -- solo NOMI dei campi modificati, mai i valori
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_user_idx on public.audit_events(user_id, created_at desc);

create table public.security_findings (
  id uuid primary key default gen_random_uuid(),
  scanner text not null,
  fingerprint text not null,
  severity text not null check (severity in ('info', 'low', 'moderate', 'high', 'critical')),
  title text not null,
  package_name text,
  fixed_version text,
  status text not null default 'open' check (status in ('open', 'fixed', 'accepted_risk', 'false_positive')),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scanner, fingerprint)
);

-- trigger updated_at su tutte le tabelle
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','clients','projects','tasks','events','schedule_blocks','plan_proposals','time_entries',
    'sleep_logs','wake_plans','meal_plans','meal_plan_items','meal_logs','hydration_logs','shopping_items',
    'workout_templates','template_exercises','workout_sessions','session_sets','trading_sessions',
    'study_items','study_sessions','study_notes','habits','habit_logs','ai_conversations','ai_messages',
    'assistant_memory','ai_usage','integration_state','sync_outbox','sync_log','oauth_tokens',
    'calendar_mappings','notifications','reports','job_runs','audit_events','security_findings'
  ] loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;
