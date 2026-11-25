/**
 * Automazioni cloud (funzionano a computer spento): GitHub Actions chiama /api/cron ogni 15 minuti.
 * Qui si decide, in ora locale dell'utente (DST-safe), quali job sono dovuti. Ogni job ha una chiave
 * di idempotenza (acquire_job): eseguito al massimo una volta, lock e massimo 3 tentativi.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "./env";
import { syncGoogleCalendar } from "./gcal-sync";
import { planAndSave, type Profile } from "./plan-service";
import { weeklyReport } from "./reports";
import { log, redact } from "./security";
import { sleepStats } from "./sleep";
import { createIronEdgeClient, runIronEdgeSync } from "./sync/ironedge";
import { supabaseSyncStore } from "./sync/store-supabase";
import { sendTelegramMessage } from "./telegram";
import { addDays, dayBoundsUtc, formatDuration, formatTime, hhmmToMinutes, localDate, minutesToHhmm, weekStart, zonedParts, zonedToUtc } from "./time";

export type DueJob = { job: string; key: string };

const DEFAULT_SCHEDULE = { morning_briefing: "07:45", evening_review: "21:30", bedtime_reminder_offset_min: 45, weekly_report_dow: 7, weekly_report: "18:00", monthly_report_day: 1, task_reminder_min: 10 };

export function dueJobs(profile: Pick<Profile, "schedule" | "target_bedtime">, now: Date, tz: string): DueJob[] {
  const s = { ...DEFAULT_SCHEDULE, ...(profile.schedule ?? {}) } as typeof DEFAULT_SCHEDULE;
  const p = zonedParts(now, tz);
  const nowMin = p.hour * 60 + p.minute;
  const day = localDate(now, tz);
  const slot = `${day}T${String(p.hour).padStart(2, "0")}:${String(Math.floor(p.minute / 15) * 15).padStart(2, "0")}`;
  const jobs: DueJob[] = [
    { job: "ironedge_sync", key: slot },
    { job: "gcal_sync", key: slot },
    { job: "task_reminders", key: slot },
  ];
  if (nowMin >= hhmmToMinutes(s.morning_briefing)) jobs.push({ job: "morning_briefing", key: day });
  if (nowMin >= hhmmToMinutes(s.evening_review)) jobs.push({ job: "evening_review", key: day });
  const bedMin = hhmmToMinutes(profile.target_bedtime.slice(0, 5));
  const remindAt = (bedMin - Number(s.bedtime_reminder_offset_min) + 1440) % 1440;
  // promemoria serale: finestra di 60 minuti dopo l'orario previsto (gestisce ritardi del cron)
  const diff = (nowMin - remindAt + 1440) % 1440;
  if (diff < 60) jobs.push({ job: "bedtime_reminder", key: remindAt > nowMin ? addDays(day, -1) : day });
  if (p.weekday === Number(s.weekly_report_dow) && nowMin >= hhmmToMinutes(s.weekly_report)) jobs.push({ job: "weekly_report", key: weekStart(day) });
  if (p.day === Number(s.monthly_report_day) && nowMin >= hhmmToMinutes(s.morning_briefing)) jobs.push({ job: "monthly_report", key: day.slice(0, 7) });
  if (nowMin >= 180) jobs.push({ job: "retention", key: day });
  return jobs;
}

async function withLock(admin: SupabaseClient, userId: string, job: string, key: string, fn: () => Promise<Record<string, unknown>>) {
  const { data: runId, error } = await admin.rpc("acquire_job", { p_user: userId, p_job: job, p_key: key, p_lock_seconds: 300 });
  if (error) throw new Error(`acquire_job: ${error.message}`);
  if (!runId) return { job, key, status: "skipped" as const };
  try {
    const stats = await fn();
    await admin.rpc("finish_job", { p_run: runId, p_status: "succeeded", p_stats: stats });
    return { job, key, status: "succeeded" as const, stats };
  } catch (e) {
    const msg = redact(e);
    log.error(`job ${job} fallito`, msg);
    await admin.rpc("finish_job", { p_run: runId, p_status: "failed", p_error: msg });
    return { job, key, status: "failed" as const, error: msg };
  }
}

/** Notifica: in-app sempre, Telegram se configurato e con opt-in. Deduplicata per chiave. */
export async function notify(admin: SupabaseClient, env: ServerEnv, profile: Profile, kind: string, title: string, body: string, dedupeKey: string) {
  const tg = env.TELEGRAM_BOT_TOKEN && profile.telegram_opt_in && profile.telegram_chat_id;
  const { data, error } = await admin
    .from("notifications")
    .upsert({ user_id: profile.user_id, channel: tg ? "telegram" : "in_app", kind, title: title.slice(0, 200), body: body.slice(0, 3900), dedupe_key: dedupeKey }, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) return false;
  if (tg) {
    try {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN!, String(profile.telegram_chat_id), `${title}\n\n${body}`.slice(0, 4000));
      await admin.from("notifications").update({ sent_at: new Date().toISOString() }).eq("id", data[0].id);
    } catch (e) {
      log.warn("notifica telegram non inviata", e);
    }
  }
  return true;
}

async function morningBriefing(admin: SupabaseClient, env: ServerEnv, profile: Profile, day: string) {
  const tz = profile.timezone;
  const { plan, saved } = await planAndSave(admin, profile, day, "scheduler");
  const { data: due } = await admin
    .from("tasks")
    .select("title, due_at")
    .eq("user_id", profile.user_id)
    .in("status", ["todo", "in_progress"])
    .lte("due_at", zonedToUtc(addDays(day, 1), "23:59", tz).toISOString())
    .order("due_at")
    .limit(10);
  const first = plan.blocks.filter((b) => !["sleep", "wind_down", "travel"].includes(b.kind)).slice(0, 8);
  const lines = [
    plan.stats.sleepDeficitMinutes >= 30 ? `Sonno: circa ${formatDuration(plan.stats.sleepDeficitMinutes)} sotto l'obiettivo, carico ridotto.` : null,
    ...first.map((b) => `${formatTime(b.start, tz)} ${b.title}`),
    due?.length ? `\nScadenze entro domani: ${due.map((d) => d.title).join(", ")}` : null,
    plan.overloaded ? `\n⚠ Giornata sovraccarica: ${plan.unscheduled.length} attivita' non entrano, ${saved.proposals} proposte da approvare.` : null,
    ...plan.warnings.slice(0, 3).map((w) => `• ${w}`),
  ].filter(Boolean) as string[];
  await admin.from("reports").upsert({ user_id: profile.user_id, kind: "morning_briefing", period_start: day, period_end: day, content: { lines, stats: plan.stats, overloaded: plan.overloaded } }, { onConflict: "user_id,kind,period_start" });
  await notify(admin, env, profile, "morning_briefing", `Briefing del mattino · ${day}`, lines.join("\n"), `briefing:${day}`);
  if (plan.conflicts.length) await notify(admin, env, profile, "conflict", "Sovrapposizioni in agenda", plan.conflicts.map((c) => c.message).join("\n"), `conflict:${day}`);
  return { blocks: saved.blocks, proposals: saved.proposals, overloaded: plan.overloaded };
}

async function taskReminders(admin: SupabaseClient, env: ServerEnv, profile: Profile, now: Date) {
  const lead = Number((profile.schedule as Record<string, number>).task_reminder_min ?? 10);
  const until = new Date(now.getTime() + (lead + 15) * 60_000).toISOString();
  const { data } = await admin
    .from("schedule_blocks")
    .select("id, title, starts_at, kind")
    .eq("user_id", profile.user_id)
    .eq("status", "planned")
    .in("kind", ["task", "event", "workout", "study", "trading"])
    .gt("starts_at", now.toISOString())
    .lte("starts_at", until)
    .limit(10);
  let sent = 0;
  for (const b of data ?? []) {
    if (await notify(admin, env, profile, "reminder", `Tra poco: ${b.title}`, `Inizio alle ${formatTime(b.starts_at, profile.timezone)}`, `reminder:${b.id}:${b.starts_at}`)) sent++;
  }
  return { sent };
}

async function eveningReview(admin: SupabaseClient, env: ServerEnv, profile: Profile, day: string) {
  const { data: blocks } = await admin.from("schedule_blocks").select("id, title, kind, status, task_id, starts_at, ends_at, actual_minutes").eq("user_id", profile.user_id).eq("plan_date", day);
  const work = (blocks ?? []).filter((b) => ["task", "workout", "study", "trading"].includes(b.kind));
  const done = work.filter((b) => b.status === "done" || b.status === "partial").length;
  const open = work.filter((b) => b.status === "planned");
  // attivita' non completate: autonome se autorizzate, proposte altrimenti (via piano di domani)
  const taskIds = [...new Set(open.map((b) => b.task_id).filter(Boolean))] as string[];
  if (taskIds.length) {
    const { data: tasks } = await admin.from("tasks").select("id, postponed_count, status").in("id", taskIds).eq("user_id", profile.user_id);
    for (const t of tasks ?? []) if (t.status !== "done") await admin.from("tasks").update({ postponed_count: t.postponed_count + 1 }).eq("id", t.id).eq("user_id", profile.user_id);
  }
  if (open.length) await admin.from("schedule_blocks").update({ status: "skipped" }).in("id", open.map((b) => b.id)).eq("user_id", profile.user_id);
  const tomorrow = addDays(day, 1);
  const { saved } = await planAndSave(admin, profile, tomorrow, "scheduler");
  const lines = [
    `Completate ${done}/${work.length} attivita' pianificate.`,
    open.length ? `Non completate: ${open.map((b) => b.title).slice(0, 6).join(", ")}. Ripianificate per domani (${saved.autoMoved.length} in autonomia, ${saved.proposals} proposte da approvare).` : null,
    `Ricorda: routine serale e riposo alle ${profile.target_bedtime.slice(0, 5)}.`,
  ].filter(Boolean) as string[];
  await admin.from("reports").upsert({ user_id: profile.user_id, kind: "evening_review", period_start: day, period_end: day, content: { lines, done, total: work.length } }, { onConflict: "user_id,kind,period_start" });
  await notify(admin, env, profile, "evening_review", `Revisione serale · ${day}`, lines.join("\n"), `evening:${day}`);
  return { done, total: work.length, carried: open.length };
}

export async function buildWeekly(admin: SupabaseClient, profile: Profile, start: string, end: string) {
  const tz = profile.timezone;
  const from = dayBoundsUtc(start, tz).start.toISOString();
  const to = dayBoundsUtc(end, tz).end.toISOString();
  const uid = profile.user_id;
  const [entries, blocks, tasks, clients, sleep, workouts, study, habits, habitLogs] = await Promise.all([
    admin.from("time_entries").select("area, client_id, minutes, started_at").eq("user_id", uid).gte("started_at", from).lt("started_at", to),
    admin.from("schedule_blocks").select("area, kind, status, starts_at, ends_at, actual_minutes").eq("user_id", uid).gte("plan_date", start).lte("plan_date", end),
    admin.from("tasks").select("status, completed_at, postponed_count, area, client_id").eq("user_id", uid).or(`completed_at.gte.${from},status.in.(todo,in_progress)`),
    admin.from("clients").select("id, name, weekly_target_minutes, active").eq("user_id", uid),
    admin.from("sleep_logs").select("night_of, bedtime, wake_time, slept_minutes").eq("user_id", uid).gte("night_of", addDays(start, -1)).lte("night_of", end),
    admin.from("workout_sessions").select("status, planned_for").eq("user_id", uid).gte("planned_for", from).lt("planned_for", to),
    admin.from("study_sessions").select("focus_minutes").eq("user_id", uid).gte("started_at", from).lt("started_at", to),
    admin.from("habits").select("id, target_per_week").eq("user_id", uid).eq("active", true),
    admin.from("habit_logs").select("habit_id").eq("user_id", uid).gte("log_date", start).lte("log_date", end),
  ]);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const ss = sleepStats(sleep.data ?? [], profile.sleep_goal_minutes, tz);
  const habitTarget = (habits.data ?? []).reduce((a, h) => a + Math.round((h.target_per_week * days) / 7), 0);
  return weeklyReport({
    periodStart: start,
    periodEnd: end,
    entries: entries.data ?? [],
    blocks: (blocks.data ?? []).map((b) => ({ ...b, minutes: (Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60000 })),
    tasks: tasks.data ?? [],
    clients: clients.data ?? [],
    sleepAvgMinutes: ss.avgMinutes,
    sleepGoalMinutes: profile.sleep_goal_minutes,
    workoutsDone: (workouts.data ?? []).filter((w) => w.status === "done").length,
    workoutsPlanned: (workouts.data ?? []).filter((w) => w.status !== "rest_day").length,
    studyMinutes: (study.data ?? []).reduce((a, s) => a + s.focus_minutes, 0),
    habitCompletion: habitTarget ? Math.min(1, (habitLogs.data ?? []).length / habitTarget) : null,
    maxWorkMinutesPerDay: profile.max_work_minutes_per_day,
    days,
  });
}

export async function runForUser(admin: SupabaseClient, env: ServerEnv, profile: Profile, now = new Date()) {
  const tz = profile.timezone;
  const day = localDate(now, tz);
  const results: unknown[] = [];
  for (const { job, key } of dueJobs(profile, now, tz)) {
    results.push(
      await withLock(admin, profile.user_id, job, key, async () => {
        switch (job) {
          case "ironedge_sync": {
            if (!env.IRONEDGE_BASE_URL || !env.IRONEDGE_SHARED_SECRET) return { skipped: "IronEdge non configurato" };
            const r = await runIronEdgeSync(supabaseSyncStore(admin, profile.user_id, tz), createIronEdgeClient(env.IRONEDGE_BASE_URL, env.IRONEDGE_SHARED_SECRET), day);
            return { ...r };
          }
          case "gcal_sync":
            return (await syncGoogleCalendar(admin, profile.user_id, env)) as Record<string, unknown>;
          case "task_reminders":
            return taskReminders(admin, env, profile, now);
          case "morning_briefing":
            return morningBriefing(admin, env, profile, day);
          case "evening_review":
            return eveningReview(admin, env, profile, day);
          case "bedtime_reminder": {
            const sent = await notify(admin, env, profile, "bedtime", "Promemoria serale", `Tra ${(profile.schedule as Record<string, number>).bedtime_reminder_offset_min ?? 45} minuti e' ora di riposare (${profile.target_bedtime.slice(0, 5)}). Schermi off e routine serale. Questo e' un promemoria: la sveglia del telefono va impostata dall'app Orologio.`, `bedtime:${key}`);
            return { sent };
          }
          case "weekly_report": {
            const start = addDays(key, -7);
            const r = await buildWeekly(admin, profile, start, addDays(key, -1));
            await admin.from("reports").upsert({ user_id: profile.user_id, kind: "weekly", period_start: start, period_end: addDays(key, -1), content: r }, { onConflict: "user_id,kind,period_start" });
            await notify(admin, env, profile, "weekly", `Report settimanale ${start}`, [`Lavoro: ${formatDuration(r.workMinutes)} (media ${formatDuration(r.avgWorkPerDay)}/giorno)`, `Task completate ${r.tasks.completed}, rimandate ${r.tasks.postponed}`, ...r.suggestions.slice(0, 4).map((s) => `• ${s}`)].join("\n"), `weekly:${start}`);
            return { suggestions: r.suggestions.length };
          }
          case "monthly_report": {
            const monthStart = `${addDays(`${key}-01`, -1).slice(0, 7)}-01`;
            const monthEnd = addDays(`${key}-01`, -1);
            const r = await buildWeekly(admin, profile, monthStart, monthEnd);
            await admin.from("reports").upsert({ user_id: profile.user_id, kind: "monthly", period_start: monthStart, period_end: monthEnd, content: r }, { onConflict: "user_id,kind,period_start" });
            await notify(admin, env, profile, "monthly", `Report mensile ${monthStart.slice(0, 7)}`, [`Studio: ${formatDuration(r.studyMinutes)} · Allenamenti ${r.workouts.done}/${r.workouts.planned}`, ...r.suggestions.slice(0, 5).map((s) => `• ${s}`)].join("\n"), `monthly:${monthStart}`);
            return { ok: true };
          }
          case "retention": {
            const { data, error } = await admin.rpc("purge_expired_data", { p_user: profile.user_id });
            if (error) throw new Error(error.message);
            return data as Record<string, unknown>;
          }
        }
        return {};
      }),
    );
  }
  return results;
}

export async function runScheduler(admin: SupabaseClient, env: ServerEnv, now = new Date()) {
  let q = admin.from("profiles").select("*");
  if (env.OWNER_USER_ID) q = q.eq("user_id", env.OWNER_USER_ID);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const out: unknown[] = [];
  for (const p of (data ?? []) as Profile[]) out.push({ user: p.user_id.slice(0, 8), results: await runForUser(admin, env, p, now) });
  return out;
}

export const _test = { minutesToHhmm };
