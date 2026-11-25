-- Personal OS - Row Level Security, integrita' e funzioni
-- Principi: ogni utente vede e modifica SOLO le proprie righe; le tabelle di sistema
-- (sync, token, job, audit) sono scrivibili solo dal service role lato server.

-- NB: non usare current_user, che dentro SECURITY DEFINER diventa il proprietario della funzione.
create or replace function app.is_service() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('role', true), 'none') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
      or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
      or (coalesce(current_setting('role', true), 'none') = 'none'
          and session_user in ('postgres', 'supabase_admin')
          and coalesce(current_setting('request.jwt.claims', true), '') = ''
          and coalesce(current_setting('request.jwt.claim.sub', true), '') = '');
$$;
grant execute on function app.is_service() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privilegi di base: anon non accede a nulla
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon, public;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- RLS abilitata e forzata ovunque
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('alter table public.%I force row level security', t.tablename);
  end loop;
end $$;

-- Tabelle di dominio: CRUD solo sulle proprie righe
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','clients','projects','tasks','events','schedule_blocks','plan_proposals','time_entries',
    'sleep_logs','wake_plans','meal_plans','meal_plan_items','meal_logs','hydration_logs','shopping_items',
    'workout_templates','template_exercises','workout_sessions','session_sets','trading_sessions',
    'study_items','study_sessions','study_notes','habits','habit_logs','ai_conversations','ai_messages',
    'assistant_memory','calendar_mappings'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_sel', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = auth.uid())', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = auth.uid())', t || '_del', t);
  end loop;
end $$;

-- Tabelle di sistema: l'utente legge solo le proprie righe, scrive solo il server
do $$
declare t text;
begin
  foreach t in array array['ai_usage','integration_state','sync_outbox','sync_log','notifications','reports','audit_events'] loop
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_sel', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
end $$;

-- Nessun accesso utente: token OAuth cifrati, job, findings di sicurezza
revoke all on public.oauth_tokens, public.job_runs, public.security_findings from authenticated;

-- ---------------------------------------------------------------------------
-- Integrita': riferimenti solo a righe dello stesso utente
-- ---------------------------------------------------------------------------
create or replace function app.guard_same_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ref_table text; ref_col text; ref_id uuid; owner uuid; i integer := 0;
begin
  while i < tg_nargs loop
    ref_table := tg_argv[i]; ref_col := tg_argv[i + 1];
    ref_id := (to_jsonb(new) ->> ref_col)::uuid;
    if ref_id is not null then
      execute format('select user_id from public.%I where id = $1', ref_table) into owner using ref_id;
      if owner is null or owner <> new.user_id then
        raise exception 'Riferimento non valido (%)', ref_col using errcode = '42501';
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end $$;

create trigger same_owner before insert or update on public.projects for each row execute function app.guard_same_owner('clients', 'client_id');
create trigger same_owner before insert or update on public.tasks for each row execute function app.guard_same_owner('clients', 'client_id', 'projects', 'project_id');
create trigger same_owner before insert or update on public.events for each row execute function app.guard_same_owner('clients', 'client_id');
create trigger same_owner before insert or update on public.schedule_blocks for each row execute function app.guard_same_owner('tasks', 'task_id', 'events', 'event_id');
create trigger same_owner before insert or update on public.time_entries for each row execute function app.guard_same_owner('clients', 'client_id', 'tasks', 'task_id', 'schedule_blocks', 'block_id');
create trigger same_owner before insert or update on public.meal_plan_items for each row execute function app.guard_same_owner('meal_plans', 'plan_id');
create trigger same_owner before insert or update on public.template_exercises for each row execute function app.guard_same_owner('workout_templates', 'template_id');
create trigger same_owner before insert or update on public.workout_sessions for each row execute function app.guard_same_owner('workout_templates', 'template_id');
create trigger same_owner before insert or update on public.session_sets for each row execute function app.guard_same_owner('workout_sessions', 'session_id');
create trigger same_owner before insert or update on public.study_sessions for each row execute function app.guard_same_owner('study_items', 'item_id');
create trigger same_owner before insert or update on public.study_notes for each row execute function app.guard_same_owner('study_items', 'item_id');
create trigger same_owner before insert or update on public.habit_logs for each row execute function app.guard_same_owner('habits', 'habit_id');
create trigger same_owner before insert or update on public.ai_messages for each row execute function app.guard_same_owner('ai_conversations', 'conversation_id');

-- user_id immutabile
create or replace function app.freeze_owner() returns trigger
language plpgsql as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id non modificabile' using errcode = '42501';
  end if;
  return new;
end $$;
do $$
declare t record;
begin
  for t in select c.table_name from information_schema.columns c
           where c.table_schema = 'public' and c.column_name = 'user_id' loop
    execute format('create trigger freeze_owner before update on public.%I for each row execute function app.freeze_owner()', t.table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Task IronEdge: IronEdge e' la fonte autorevole.
--  * solo il server (sync) crea o modifica i campi sincronizzati;
--  * l'utente puo' cambiare lo stato (done/todo/in_progress) e le preferenze di pianificazione;
--  * ogni cambio di stato utente genera, nella STESSA transazione, una voce di outbox
--    con il payload minimo (nessun dato personale).
-- ---------------------------------------------------------------------------
create or replace function app.guard_synced_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if app.is_service() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if new.source <> 'local' or new.external_id is not null then
      raise exception 'Solo la sincronizzazione puo'' creare task esterne' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.source <> 'local' then
      raise exception 'Le task IronEdge non si eliminano da Personal OS: gestiscile in IronEdge' using errcode = '42501';
    end if;
    return old;
  end if;
  -- UPDATE
  if old.source <> 'local' then
    if new.title is distinct from old.title or new.description is distinct from old.description
       or new.priority is distinct from old.priority or new.due_at is distinct from old.due_at
       or new.estimated_minutes is distinct from old.estimated_minutes or new.category is distinct from old.category
       or new.depends_on is distinct from old.depends_on or new.source is distinct from old.source
       or new.external_id is distinct from old.external_id or new.external_group_id is distinct from old.external_group_id or new.external_url is distinct from old.external_url
       or new.external_version is distinct from old.external_version
       or new.external_payload_hash is distinct from old.external_payload_hash
       or new.last_synced_at is distinct from old.last_synced_at then
      raise exception 'Campo gestito da IronEdge: modificalo nel gestionale originale' using errcode = '42501';
    end if;
    if new.status in ('skipped', 'cancelled') and new.status is distinct from old.status then
      raise exception 'Per le task IronEdge sono consentiti solo da fare / in corso / completata' using errcode = '22023';
    end if;
    if new.status is distinct from old.status then
      new.completed_at := case when new.status = 'done' then coalesce(new.completed_at, now()) else null end;
      new.local_dirty := true;
      -- solo l'ultimo stato conta: le voci precedenti non ancora inviate vengono superate
      update public.sync_outbox set status = 'done', last_error = 'superata da modifica successiva'
       where entity_id = new.id and provider = 'ironedge' and status in ('pending', 'failed');
      insert into public.sync_outbox (user_id, provider, operation, entity_id, payload, idempotency_key)
      values (
        new.user_id, 'ironedge', 'set_status', new.id,
        jsonb_build_object(
          'external_id', new.external_id,
          'status', case when new.status = 'done' then 'done' else 'open' end,
          'base_version', new.external_version
        ),
        'task:' || new.id || ':' || gen_random_uuid()
      );
    end if;
  else
    if new.source <> 'local' or new.external_id is not null then
      raise exception 'Non e'' possibile trasformare una task locale in esterna' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      new.completed_at := case when new.status = 'done' then coalesce(new.completed_at, now()) else null end;
    end if;
  end if;
  return new;
end $$;
create trigger guard_synced before insert or update or delete on public.tasks
  for each row execute function app.guard_synced_task();

-- ---------------------------------------------------------------------------
-- Eventi con altre persone / esterni / fissi: le modifiche dell'assistente passano da proposte.
-- A livello DB: impedire che l'origine Google venga alterata dal client.
-- ---------------------------------------------------------------------------
create or replace function app.guard_event_origin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if app.is_service() then return new; end if;
  if tg_op = 'INSERT' and (new.origin <> 'personal_os' or new.gcal_event_id is not null) then
    raise exception 'Gli eventi Google sono importati solo dalla sincronizzazione' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.origin is distinct from old.origin or new.gcal_event_id is distinct from old.gcal_event_id
      or new.gcal_calendar_id is distinct from old.gcal_calendar_id or new.gcal_etag is distinct from old.gcal_etag
      or new.gcal_synced_at is distinct from old.gcal_synced_at) then
    raise exception 'Campi di sincronizzazione Google non modificabili' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_origin before insert or update on public.events for each row execute function app.guard_event_origin();

-- ---------------------------------------------------------------------------
-- RPC utente
-- ---------------------------------------------------------------------------
create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Autenticazione richiesta' using errcode = '42501'; end if;
  insert into public.profiles (user_id) values (auth.uid()) on conflict (user_id) do nothing;
end $$;
grant execute on function public.ensure_profile() to authenticated;

create or replace function public.mark_notification_read(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.notifications set read_at = coalesce(read_at, now()) where id = p_id and user_id = auth.uid();
end $$;
grant execute on function public.mark_notification_read(uuid) to authenticated;

-- Decisione su una proposta: solo il proprietario approva/rifiuta
create or replace function public.decide_proposal(p_id uuid, p_approve boolean) returns public.proposal_status
language plpgsql security definer set search_path = '' as $$
declare s public.proposal_status;
begin
  update public.plan_proposals
     set status = case when p_approve then 'approved'::public.proposal_status else 'rejected'::public.proposal_status end,
         decided_at = now()
   where id = p_id and user_id = auth.uid() and status = 'pending'
     and (expires_at is null or expires_at > now())
  returning status into s;
  if s is null then raise exception 'Proposta non trovata, gia'' decisa o scaduta' using errcode = '42501'; end if;
  insert into public.audit_events (user_id, actor, action, entity, entity_id)
  values (auth.uid(), 'user', case when p_approve then 'approve' else 'reject' end, 'plan_proposals', p_id);
  return s;
end $$;
grant execute on function public.decide_proposal(uuid, boolean) to authenticated;

-- Diritto all'oblio: elimina tutti i dati dell'utente (non l'account Auth)
create or replace function public.delete_my_data(p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); t record; n integer; total integer := 0;
begin
  if uid is null then raise exception 'Autenticazione richiesta' using errcode = '42501'; end if;
  if p_confirm <> 'ELIMINA TUTTO' then raise exception 'Conferma non valida' using errcode = '22023'; end if;
  for t in select c.table_name from information_schema.columns c
           join information_schema.tables tt on tt.table_schema = c.table_schema and tt.table_name = c.table_name and tt.table_type = 'BASE TABLE'
           where c.table_schema = 'public' and c.column_name = 'user_id' and c.table_name <> 'profiles' loop
    execute format('delete from public.%I where user_id = $1', t.table_name) using uid;
    get diagnostics n = row_count; total := total + n;
  end loop;
  delete from public.profiles where user_id = uid;
  return jsonb_build_object('deleted_rows', total);
end $$;
grant execute on function public.delete_my_data(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Funzioni di sistema (solo service role)
-- ---------------------------------------------------------------------------
create or replace function public.acquire_job(p_user uuid, p_job text, p_key text, p_lock_seconds integer default 300)
returns uuid language plpgsql security definer set search_path = '' as $$
declare run_id uuid; existing public.job_runs%rowtype;
begin
  if not app.is_service() then raise exception 'Solo service role' using errcode = '42501'; end if;
  select * into existing from public.job_runs
   where coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_user, '00000000-0000-0000-0000-000000000000'::uuid)
     and job = p_job and idempotency_key = p_key
   for update;
  if not found then
    insert into public.job_runs (user_id, job, idempotency_key, status, locked_until)
    values (p_user, p_job, p_key, 'running', now() + make_interval(secs => p_lock_seconds))
    returning id into run_id;
    return run_id;
  end if;
  if existing.status in ('succeeded', 'skipped') then return null; end if;
  if existing.status = 'running' and existing.locked_until > now() then return null; end if;
  if existing.attempt >= 3 then return null; end if;
  update public.job_runs
     set status = 'running', attempt = existing.attempt + 1, error_redacted = null,
         locked_until = now() + make_interval(secs => p_lock_seconds), started_at = now(), finished_at = null
   where id = existing.id;
  return existing.id;
end $$;

create or replace function public.finish_job(p_run uuid, p_status public.run_status, p_error text default null, p_stats jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service() then raise exception 'Solo service role' using errcode = '42501'; end if;
  update public.job_runs
     set status = p_status, finished_at = now(), locked_until = null,
         error_redacted = left(p_error, 500), stats = coalesce(p_stats, '{}'::jsonb)
   where id = p_run;
end $$;

-- Prende in carico le voci di outbox dovute (lock ottimistico, nessuna doppia elaborazione)
create or replace function public.claim_outbox(p_provider text, p_user uuid, p_limit integer default 20)
returns setof public.sync_outbox language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_service() then raise exception 'Solo service role' using errcode = '42501'; end if;
  -- voci rimaste "processing" oltre 10 minuti (crash) tornano disponibili
  update public.sync_outbox set status = 'pending'
   where provider = p_provider and user_id = p_user and status = 'processing' and updated_at < now() - interval '10 minutes';
  return query
  update public.sync_outbox o
     set status = 'processing', attempts = o.attempts + 1
   where o.id in (
     select id from public.sync_outbox
      where provider = p_provider and user_id = p_user and status in ('pending', 'failed') and next_attempt_at <= now()
      order by created_at
      limit greatest(1, least(p_limit, 100))
      for update skip locked
   )
  returning o.*;
end $$;

-- Esito di una voce di outbox con backoff esponenziale (1, 2, 4 ... max 6h) e dead-letter dopo 8 tentativi
create or replace function public.complete_outbox(p_id uuid, p_ok boolean, p_error text default null)
returns public.outbox_status language plpgsql security definer set search_path = '' as $$
declare r public.sync_outbox%rowtype; s public.outbox_status;
begin
  if not app.is_service() then raise exception 'Solo service role' using errcode = '42501'; end if;
  select * into r from public.sync_outbox where id = p_id for update;
  if not found then return null; end if;
  if p_ok then
    s := 'done';
  elsif r.attempts >= 8 then
    s := 'dead';
  else
    s := 'failed';
  end if;
  update public.sync_outbox
     set status = s,
         last_error = case when p_ok then null else left(p_error, 500) end,
         next_attempt_at = case when p_ok then next_attempt_at
                                else now() + least(interval '6 hours', make_interval(mins => (power(2, greatest(r.attempts - 1, 0)))::integer)) end
   where id = p_id;
  return s;
end $$;

create or replace function public.purge_expired_data(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare days integer; cutoff timestamptz; n1 integer; n2 integer; n3 integer; n4 integer;
begin
  if not app.is_service() then raise exception 'Solo service role' using errcode = '42501'; end if;
  select retention_days into days from public.profiles where user_id = p_user;
  if days is null then return '{}'::jsonb; end if;
  cutoff := now() - make_interval(days => days);
  delete from public.notifications where user_id = p_user and created_at < cutoff; get diagnostics n1 = row_count;
  delete from public.sync_log where user_id = p_user and created_at < least(cutoff, now() - interval '180 days'); get diagnostics n2 = row_count;
  delete from public.sync_outbox where user_id = p_user and status in ('done', 'dead') and updated_at < now() - interval '30 days'; get diagnostics n3 = row_count;
  delete from public.ai_messages where user_id = p_user and created_at < cutoff; get diagnostics n4 = row_count;
  return jsonb_build_object('notifications', n1, 'sync_log', n2, 'sync_outbox', n3, 'ai_messages', n4, 'cutoff', cutoff);
end $$;

revoke execute on function public.acquire_job(uuid, text, text, integer), public.finish_job(uuid, public.run_status, text, jsonb),
  public.claim_outbox(text, uuid, integer), public.complete_outbox(uuid, boolean, text), public.purge_expired_data(uuid)
  from authenticated, public;
grant execute on function public.acquire_job(uuid, text, text, integer), public.finish_job(uuid, public.run_status, text, jsonb),
  public.claim_outbox(text, uuid, integer), public.complete_outbox(uuid, boolean, text), public.purge_expired_data(uuid)
  to service_role;
