/**
 * Servizio di pianificazione: carica i dati (RLS dell'utente o service role filtrato per user_id),
 * esegue il motore deterministico e salva il piano. Usato da UI, assistente e job notturni.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LifeArea } from "./domain";
import { eventToFixed, isoWeekday, mealsForDay, type MealItem } from "./planning";
import { planDay, rescheduleIncomplete, type FixedItem, type FlexibleTask, type PlanResult, type Settings } from "./scheduler/engine";
import { addDays, dayBoundsUtc, localDate } from "./time";

export type Profile = {
  user_id: string;
  timezone: string;
  sleep_goal_minutes: number;
  target_bedtime: string;
  target_wake: string;
  workday_start: string;
  workday_end: string;
  max_work_minutes_per_day: number;
  buffer_percent: number;
  auto_reschedule_areas: LifeArea[];
  schedule: Record<string, string | number>;
  ai_consent: boolean;
  ai_share_health: boolean;
  telegram_opt_in: boolean;
  telegram_chat_id: number | null;
  display_name: string | null;
  retention_days: number;
  default_travel_minutes: number;
};

const hhmm = (t: string) => t.slice(0, 5);

export function settingsFrom(p: Profile): Settings {
  return {
    timezone: p.timezone,
    targetWake: hhmm(p.target_wake),
    targetBedtime: hhmm(p.target_bedtime),
    sleepGoalMinutes: p.sleep_goal_minutes,
    workdayStart: hhmm(p.workday_start),
    workdayEnd: hhmm(p.workday_end),
    maxWorkMinutes: p.max_work_minutes_per_day,
    bufferPercent: p.buffer_percent,
  };
}

export async function loadProfile(db: SupabaseClient, userId: string): Promise<Profile> {
  const { data, error } = await db.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Profilo non inizializzato");
  return data as Profile;
}

type TaskRow = {
  id: string;
  title: string;
  area: LifeArea;
  priority: number;
  estimated_minutes: number | null;
  due_at: string | null;
  depends_on: string[];
  status: string;
  client_id: string | null;
  auto_reschedule: boolean | null;
  flexibility: string;
};

export function canAutoReschedule(t: { area: LifeArea; auto_reschedule: boolean | null }, allowedAreas: LifeArea[]): boolean {
  return t.auto_reschedule ?? allowedAreas.includes(t.area);
}

export async function loadPlanInput(db: SupabaseClient, profile: Profile, date: string, extra?: { fixed?: FixedItem[]; tasks?: FlexibleTask[] }) {
  const tz = profile.timezone;
  const { start, end } = dayBoundsUtc(date, tz);
  const horizon = dayBoundsUtc(addDays(date, 7), tz).end.toISOString();
  const uid = profile.user_id;
  const [events, trading, workouts, tasks, sleep, plans] = await Promise.all([
    db.from("events").select("id, title, area, starts_at, ends_at, travel_before_minutes, travel_after_minutes, involves_others, is_external").eq("user_id", uid).lt("starts_at", end.toISOString()).gt("ends_at", start.toISOString()),
    db.from("trading_sessions").select("id, title, kind, starts_at, ends_at, fixed, status").eq("user_id", uid).neq("status", "skipped").lt("starts_at", end.toISOString()).gt("ends_at", start.toISOString()),
    db.from("workout_sessions").select("id, planned_for, duration_minutes, status, template:workout_templates(name, estimated_minutes)").eq("user_id", uid).eq("status", "planned").gte("planned_for", start.toISOString()).lt("planned_for", end.toISOString()),
    db.from("tasks").select("id, title, area, priority, estimated_minutes, due_at, depends_on, status, client_id, auto_reschedule, flexibility").eq("user_id", uid).in("status", ["todo", "in_progress", "done"]).or(`due_at.is.null,due_at.lte.${horizon}`).limit(400),
    db.from("sleep_logs").select("slept_minutes, bedtime, wake_time").eq("user_id", uid).eq("night_of", addDays(date, -1)).maybeSingle(),
    db.from("meal_plans").select("id, meal_plan_items(weekday, slot, time_hint, description)").eq("user_id", uid).eq("active", true).limit(1),
  ]);
  for (const r of [events, trading, workouts, tasks, sleep, plans]) if (r.error) throw new Error(r.error.message);

  const fixed: FixedItem[] = (events.data ?? []).map((e) => eventToFixed(e as Parameters<typeof eventToFixed>[0]));
  for (const t of trading.data ?? []) {
    if (t.fixed) fixed.push({ id: t.id, title: t.title, area: "trading", start: new Date(t.starts_at), end: new Date(t.ends_at), kind: "trading" });
  }
  const flex: FlexibleTask[] = [];
  for (const t of trading.data ?? []) {
    if (!t.fixed && t.status === "planned") {
      flex.push({ id: t.id, title: t.title, area: "trading", priority: 2, estimatedMinutes: Math.round((Date.parse(t.ends_at) - Date.parse(t.starts_at)) / 60000), dueAt: new Date(t.ends_at), dependsOn: [], done: false, autoReschedule: canAutoReschedule({ area: "trading", auto_reschedule: null }, profile.auto_reschedule_areas), kind: "trading" });
    }
  }
  for (const w of workouts.data ?? []) {
    const tpl = (w as unknown as { template: { name: string; estimated_minutes: number } | null }).template;
    flex.push({ id: w.id, title: tpl?.name ?? "Allenamento", area: "gym", priority: 2, estimatedMinutes: w.duration_minutes ?? tpl?.estimated_minutes ?? 60, dueAt: null, dependsOn: [], done: false, autoReschedule: canAutoReschedule({ area: "gym", auto_reschedule: null }, profile.auto_reschedule_areas), kind: "workout" });
  }
  const endIso = end.toISOString();
  for (const t of (tasks.data ?? []) as TaskRow[]) {
    // task fisse con scadenza oggi o prima, oppure flessibili senza scadenza/entro l'orizzonte
    if (t.status !== "done" && t.due_at && t.due_at > endIso && t.priority > 2) continue;
    flex.push({
      id: t.id,
      title: t.title,
      area: t.area,
      priority: Math.min(4, Math.max(1, t.priority)) as 1 | 2 | 3 | 4,
      estimatedMinutes: t.estimated_minutes,
      dueAt: t.due_at ? new Date(t.due_at) : null,
      dependsOn: t.depends_on ?? [],
      done: t.status === "done",
      clientId: t.client_id,
      autoReschedule: canAutoReschedule(t, profile.auto_reschedule_areas),
    });
  }
  const items = ((plans.data?.[0] as { meal_plan_items?: MealItem[] } | undefined)?.meal_plan_items ?? []) as MealItem[];
  const dayMeals = mealsForDay(items, isoWeekday(date, tz))
    .filter((m) => m.time_hint)
    .map((m) => ({ slot: m.slot, time: m.time_hint!.slice(0, 5), minutes: m.slot === "snack" ? 15 : m.slot === "breakfast" ? 20 : 45 }));
  const s = sleep.data as { slept_minutes: number | null; bedtime: string | null; wake_time: string | null } | null;
  const slept = s?.slept_minutes ?? (s?.bedtime && s?.wake_time ? Math.round((Date.parse(s.wake_time) - Date.parse(s.bedtime)) / 60000) : null);
  return {
    date,
    settings: settingsFrom(profile),
    fixed: [...fixed, ...(extra?.fixed ?? [])],
    tasks: [...flex, ...(extra?.tasks ?? [])],
    meals: dayMeals.length ? dayMeals : undefined,
    lastNightSleepMinutes: slept,
  };
}

/** Salva il piano: sostituisce SOLO i blocchi ancora "planned" del giorno; crea proposte per conflitti e rinvii non autorizzati. */
export async function savePlan(db: SupabaseClient, userId: string, plan: PlanResult, createdBy: "scheduler" | "assistant" | "user" = "user") {
  const del = await db.from("schedule_blocks").delete().eq("user_id", userId).eq("plan_date", plan.date).eq("status", "planned");
  if (del.error) throw new Error(del.error.message);
  const taskIds = new Set<string>();
  const { data: realTasks } = await db.from("tasks").select("id").eq("user_id", userId).in("id", plan.blocks.filter((b) => b.refId).map((b) => b.refId!));
  for (const t of realTasks ?? []) taskIds.add(t.id);
  const rows = plan.blocks.map((b) => ({
    user_id: userId,
    plan_date: plan.date,
    starts_at: b.start.toISOString(),
    ends_at: b.end.toISOString(),
    area: b.area,
    kind: b.kind,
    title: b.part ? `${b.title} (${b.part.index}/${b.part.of})` : b.title,
    task_id: b.refId && taskIds.has(b.refId) ? b.refId : null,
    flexibility: b.flexibility,
  }));
  if (rows.length) {
    const ins = await db.from("schedule_blocks").insert(rows);
    if (ins.error) throw new Error(ins.error.message);
  }
  const proposals: Record<string, unknown>[] = [];
  for (const c of plan.conflicts) {
    proposals.push({ user_id: userId, kind: "move_event", summary: c.message.slice(0, 500), reason: "Sovrapposizione tra impegni fissi", payload: { date: plan.date, a: c.a, b: c.b, overlap: c.overlapMinutes }, created_by: createdBy, expires_at: dayBoundsUtc(plan.date, "UTC").end.toISOString() });
  }
  const decisions = rescheduleIncomplete(plan.unscheduled.map((u) => ({ id: u.taskId, title: u.title, autoReschedule: u.autoReschedule, fixed: false })), plan.date);
  const toPropose = decisions.filter((d) => d.action === "propose" && taskIds.has(d.taskId));
  if (toPropose.length) {
    proposals.push({
      user_id: userId,
      kind: "reschedule_task",
      summary: `Rimandare a domani ${toPropose.length} attivita' che non entrano oggi: ${toPropose.map((d) => d.title).slice(0, 5).join(", ")}${toPropose.length > 5 ? "…" : ""}`.slice(0, 500),
      reason: "Capacita' o tempo libero insufficienti (sonno e margine per imprevisti preservati)",
      payload: { date: plan.date, toDate: addDays(plan.date, 1), taskIds: toPropose.map((d) => d.taskId) },
      created_by: createdBy,
    });
  }
  const autoMoved = decisions.filter((d) => d.action === "auto_move" && taskIds.has(d.taskId)).map((d) => d.taskId);
  if (proposals.length) {
    // niente duplicati: elimina le proposte pendenti dello stesso giorno generate in precedenza
    await db.from("plan_proposals").delete().eq("user_id", userId).eq("status", "pending").in("kind", ["move_event", "reschedule_task"]).filter("payload->>date", "eq", plan.date);
    const r = await db.from("plan_proposals").insert(proposals);
    if (r.error) throw new Error(r.error.message);
  }
  return { blocks: rows.length, proposals: proposals.length, autoMoved };
}

export async function planAndSave(db: SupabaseClient, profile: Profile, date: string, createdBy: "scheduler" | "assistant" | "user" = "user", extra?: { fixed?: FixedItem[]; tasks?: FlexibleTask[] }) {
  const input = await loadPlanInput(db, profile, date, extra);
  const plan = planDay(input);
  const saved = await savePlan(db, profile.user_id, plan, createdBy);
  return { plan, saved };
}

export function todayFor(profile: Pick<Profile, "timezone">, now = new Date()) {
  return localDate(now, profile.timezone);
}
