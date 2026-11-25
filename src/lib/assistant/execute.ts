/**
 * Esecuzione sicura degli intenti. Regole:
 *  - legge e scrive SOLO con il client dell'utente (RLS);
 *  - non modifica mai impegni fissi, riunioni con altre persone o eventi esterni: crea proposte;
 *  - riprogramma attivita' flessibili solo se l'utente lo ha autorizzato (aree/attivita');
 *  - risposte basate su dati registrati, senza statistiche inventate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { AREA_LABEL, type LifeArea } from "../domain";
import { loadPlanInput, planAndSave, type Profile } from "../plan-service";
import { pickWorkoutDays } from "../planning";
import { findDailySlots, planDay } from "../scheduler/engine";
import { addDays, dayBoundsUtc, formatDuration, formatTime, minutesToHhmm, weekStart, zonedToUtc } from "../time";
import { HELP_TEXT, type Intent } from "./intents";

export type ExecResult = { reply: string; changed: boolean };

function summarizePlan(plan: Awaited<ReturnType<typeof planAndSave>>["plan"], tz: string): string {
  const lines = plan.blocks
    .filter((b) => !["sleep", "travel"].includes(b.kind))
    .slice(0, 18)
    .map((b) => `${formatTime(b.start, tz)}–${formatTime(b.end, tz)} · ${b.title}${b.flexibility === "fixed" ? " (fisso)" : ""}`);
  const out = [...lines];
  if (plan.warnings.length) out.push("", ...plan.warnings.map((w) => `⚠ ${w}`));
  if (plan.conflicts.length) out.push(`${plan.conflicts.length} sovrapposizioni: trovi le proposte da approvare in "Oggi".`);
  out.push("", `Lavoro pianificato ${formatDuration(plan.stats.workPlannedMinutes)} su ${formatDuration(plan.stats.workCapacityMinutes)} disponibili · margine imprevisti ${formatDuration(plan.stats.bufferMinutes)}.`);
  return out.join("\n");
}

export async function executeIntent(db: SupabaseClient, profile: Profile, intent: Intent, today: string): Promise<ExecResult> {
  const tz = profile.timezone;
  const uid = profile.user_id;
  const dateOf = (d: "today" | "tomorrow") => (d === "tomorrow" ? addDays(today, 1) : today);

  switch (intent.intent) {
    case "help":
      return { reply: HELP_TEXT, changed: false };

    case "plan_day": {
      const date = dateOf(intent.day);
      const { plan, saved } = await planAndSave(db, profile, date, "assistant");
      return { reply: `Piano per ${intent.day === "tomorrow" ? "domani" : "oggi"} (${date}):\n${summarizePlan(plan, tz)}${saved.proposals ? `\n${saved.proposals} proposte attendono la tua approvazione.` : ""}`, changed: true };
    }

    case "log_sleep": {
      const night = addDays(today, -1);
      const up = await db.from("sleep_logs").upsert({ user_id: uid, night_of: night, slept_minutes: intent.minutes, source: "manual" }, { onConflict: "user_id,night_of" });
      if (up.error) throw new Error(up.error.message);
      const { plan } = await planAndSave(db, profile, today, "assistant");
      return {
        reply: `Registrate ${formatDuration(intent.minutes)} di sonno per la notte del ${night}.\n${intent.minutes < profile.sleep_goal_minutes ? "Ho ridotto il carico di lavoro di oggi invece di allungare la giornata.\n" : ""}${summarizePlan(plan, tz)}`,
        changed: true,
      };
    }

    case "allocate_client": {
      const date = dateOf(intent.day);
      let clientId: string | null = null;
      let clientName = "cliente";
      if (intent.client) {
        const { data } = await db.from("clients").select("id, name").eq("user_id", uid).ilike("name", `%${intent.client.replace(/[%_\\]/g, "")}%`).limit(1);
        if (data?.[0]) ({ id: clientId, name: clientName } = data[0]);
      }
      if (!clientId) {
        const { data } = await db.from("clients").select("id, name").eq("user_id", uid).eq("active", true).order("priority").limit(2);
        if (data?.length === 1) ({ id: clientId, name: clientName } = data[0]);
        else if (!intent.client) return { reply: "Per quale cliente? Ripeti indicando il nome, ad es. \"dedicare tre ore al cliente Rossi\".", changed: false };
        else return { reply: `Non trovo il cliente "${intent.client}". Aggiungilo in Lavoro › Marketing.`, changed: false };
      }
      const ins = await db.from("tasks").insert({ user_id: uid, area: "marketing", client_id: clientId, title: `Lavoro per ${clientName}`, estimated_minutes: intent.minutes, priority: 2, due_at: zonedToUtc(date, "23:59", tz).toISOString(), category: "blocco cliente" }).select("id").single();
      if (ins.error) throw new Error(ins.error.message);
      const { plan } = await planAndSave(db, profile, date, "assistant");
      const placed = plan.blocks.filter((b) => b.refId === ins.data.id).reduce((a, b) => a + (b.endMin - b.startMin), 0);
      return {
        reply: placed >= intent.minutes
          ? `Ho riservato ${formatDuration(intent.minutes)} per ${clientName} il ${date}.\n${summarizePlan(plan, tz)}`
          : `Ho creato l'attivita' per ${clientName}, ma il ${date} entrano solo ${formatDuration(placed)}: non comprimo sonno e pause. Valuta la proposta di spostamento.\n${summarizePlan(plan, tz)}`,
        changed: true,
      };
    }

    case "replan_around": {
      const date = dateOf(intent.day);
      const extra =
        intent.start && intent.end
          ? { fixed: [{ id: "nuovo-appuntamento", title: "Appuntamento", area: "personal" as LifeArea, start: zonedToUtc(date, intent.start, tz), end: zonedToUtc(date, intent.end, tz), kind: "event" as const }] }
          : undefined;
      if (extra) {
        const ev = await db.from("events").insert({ user_id: uid, title: "Appuntamento", area: "personal", starts_at: extra.fixed[0].start.toISOString(), ends_at: extra.fixed[0].end.toISOString(), flexibility: "fixed" }).select("id").single();
        if (ev.error) throw new Error(ev.error.message);
      }
      const { plan, saved } = await planAndSave(db, profile, date, "assistant");
      return {
        reply: `${extra ? `Aggiunto l'appuntamento ${intent.start}–${intent.end}. ` : "Ripianificato. "}Le attivita' flessibili sono state ricollocate; impegni fissi e riunioni non sono stati toccati.${saved.autoMoved.length ? ` ${saved.autoMoved.length} attivita' autorizzate passano a domani.` : ""}${saved.proposals ? ` ${saved.proposals} proposte richiedono la tua approvazione.` : ""}\n${summarizePlan(plan, tz)}`,
        changed: true,
      };
    }

    case "plan_workouts": {
      const ws = weekStart(today);
      const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter((d) => d >= today);
      const { start } = dayBoundsUtc(days[0], tz);
      const { end } = dayBoundsUtc(days[days.length - 1], tz);
      const [ev, wk, tpl] = await Promise.all([
        db.from("events").select("starts_at, ends_at, area").eq("user_id", uid).gte("starts_at", start.toISOString()).lt("starts_at", end.toISOString()),
        db.from("workout_sessions").select("planned_for, status").eq("user_id", uid).gte("planned_for", start.toISOString()).lt("planned_for", end.toISOString()),
        db.from("workout_templates").select("id, name, estimated_minutes").eq("user_id", uid).eq("active", true).order("created_at"),
      ]);
      const loads = days.map((d) => {
        const b = dayBoundsUtc(d, tz);
        const inDay = (iso: string) => iso >= b.start.toISOString() && iso < b.end.toISOString();
        const busy = (ev.data ?? []).filter((e) => inDay(e.starts_at)).reduce((a, e) => a + (Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60000, 0);
        return { date: d, busyMinutes: busy, fixedWorkMinutes: busy, hasWorkout: (wk.data ?? []).some((w) => w.planned_for && inDay(w.planned_for)), restDay: (wk.data ?? []).some((w) => w.status === "rest_day" && w.planned_for && inDay(w.planned_for)) };
      });
      const already = loads.filter((l) => l.hasWorkout).length;
      const { chosen, warning } = pickWorkoutDays(loads, intent.count);
      const newDays = chosen.filter((d) => !loads.find((l) => l.date === d)?.hasWorkout);
      const templates = tpl.data ?? [];
      const rows = newDays.map((d, i) => {
        const t = templates.length ? templates[(already + i) % templates.length] : null;
        // orario indicativo dentro la finestra libera: lo scheduler lo colloca nel piano giornaliero
        return { user_id: uid, template_id: t?.id ?? null, planned_for: zonedToUtc(d, "18:00", tz).toISOString(), duration_minutes: t?.estimated_minutes ?? 60, status: "planned" };
      });
      if (rows.length) {
        const r = await db.from("workout_sessions").insert(rows);
        if (r.error) throw new Error(r.error.message);
      }
      return {
        reply: `${rows.length ? `Aggiunti ${rows.length} allenamenti: ${newDays.join(", ")}.` : "Nessun nuovo allenamento aggiunto."}${already ? ` (${already} gia' pianificati)` : ""} Ho evitato giorni consecutivi per il recupero e preferito i giorni meno carichi; l'orario esatto viene scelto nel piano giornaliero.${warning ? `\n⚠ ${warning}` : ""}${templates.length ? "" : "\nCrea una scheda in Palestra per associare gli esercizi."}`,
        changed: rows.length > 0,
      };
    }

    case "find_study_slots": {
      const plans = [];
      for (let i = 0; i < intent.days; i++) {
        plans.push(planDay(await loadPlanInput(db, profile, addDays(today, i))));
      }
      const slots = findDailySlots(plans, intent.minutes);
      if (!slots.length) return { reply: "Non trovo spazi liberi senza toccare sonno, pasti e margine per imprevisti.", changed: false };
      return {
        reply: `Spazi liberi di ${formatDuration(intent.minutes)} per lo studio:\n${slots.map((s) => `• ${s.date}: ${minutesToHhmm(s.startMin)}–${minutesToHhmm(s.endMin)}`).join("\n")}${slots.length < intent.days ? `\nIn ${intent.days - slots.length} giorni non c'e' spazio sufficiente.` : ""}\nAggiungi in Studio una sessione o un obiettivo settimanale per bloccarli nel piano.`,
        changed: false,
      };
    }

    case "neglected_clients": {
      const since = zonedToUtc(addDays(today, -14), "00:00", tz).toISOString();
      const [clients, entries, tasks] = await Promise.all([
        db.from("clients").select("id, name, weekly_target_minutes, priority").eq("user_id", uid).eq("active", true),
        db.from("time_entries").select("client_id, minutes").eq("user_id", uid).gte("started_at", since).not("client_id", "is", null),
        db.from("tasks").select("client_id, due_at, status").eq("user_id", uid).in("status", ["todo", "in_progress"]).not("client_id", "is", null),
      ]);
      const list = clients.data ?? [];
      if (!list.length) return { reply: "Non hai ancora clienti registrati.", changed: false };
      const mins = new Map<string, number>();
      for (const e of entries.data ?? []) mins.set(e.client_id!, (mins.get(e.client_id!) ?? 0) + e.minutes);
      const overdue = new Map<string, number>();
      const nowIso = new Date().toISOString();
      for (const t of tasks.data ?? []) if (t.due_at && t.due_at < nowIso) overdue.set(t.client_id!, (overdue.get(t.client_id!) ?? 0) + 1);
      const rows = list
        .map((c) => ({ ...c, spent: mins.get(c.id) ?? 0, overdue: overdue.get(c.id) ?? 0, target2w: c.weekly_target_minutes ? c.weekly_target_minutes * 2 : null }))
        .filter((c) => c.overdue > 0 || (c.target2w ? c.spent < c.target2w * 0.5 : c.spent === 0))
        .sort((a, b) => b.overdue - a.overdue || a.spent - b.spent);
      if (!rows.length) return { reply: "Negli ultimi 14 giorni nessun cliente risulta trascurato in base al tempo registrato e alle scadenze.", changed: false };
      return {
        reply: `Clienti che richiedono attenzione (ultimi 14 giorni, in base al tempo registrato):\n${rows.map((c) => `• ${c.name}: ${formatDuration(c.spent)}${c.target2w ? ` su ${formatDuration(c.target2w)} previste` : ""}${c.overdue ? `, ${c.overdue} task scadute` : ""}`).join("\n")}\nSe il tempo non viene registrato, il dato e' sottostimato.`,
        changed: false,
      };
    }

    case "ironedge_open": {
      const { data, error } = await db.from("tasks").select("title, due_at, status, external_url, priority").eq("user_id", uid).eq("source", "ironedge").in("status", ["todo", "in_progress"]).order("due_at", { ascending: true }).limit(30);
      if (error) throw new Error(error.message);
      const { data: st } = await db.from("integration_state").select("last_success_at, last_error").eq("user_id", uid).eq("provider", "ironedge").maybeSingle();
      const syncNote = st?.last_success_at ? `Ultima sincronizzazione: ${new Date(st.last_success_at).toLocaleString("it-IT", { timeZone: tz })}.` : "Sincronizzazione IronEdge non ancora eseguita: i dati potrebbero non essere aggiornati.";
      if (!data?.length) return { reply: `Nessuna task IronEdge incompleta. ${syncNote}`, changed: false };
      return { reply: `Task IronEdge incomplete (${data.length}):\n${data.map((t) => `• ${t.title}${t.due_at ? ` — entro ${new Date(t.due_at).toLocaleDateString("it-IT", { timeZone: tz })}` : ""}`).join("\n")}\n${syncNote}`, changed: false };
    }

    case "time_spent": {
      const from = intent.period === "week" ? weekStart(today) : `${today.slice(0, 8)}01`;
      const { data, error } = await db.from("time_entries").select("minutes, client_id").eq("user_id", uid).eq("area", intent.area).gte("started_at", zonedToUtc(from, "00:00", tz).toISOString());
      if (error) throw new Error(error.message);
      const total = (data ?? []).reduce((a, e) => a + e.minutes, 0);
      const { data: blocks } = await db.from("schedule_blocks").select("starts_at, ends_at").eq("user_id", uid).eq("area", intent.area).gte("plan_date", from).lte("plan_date", today);
      const planned = (blocks ?? []).reduce((a, b) => a + (Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60000, 0);
      return {
        reply: `${AREA_LABEL[intent.area]} ${intent.period === "week" ? "questa settimana" : "questo mese"}: ${formatDuration(total)} registrate${planned ? ` (pianificate ${formatDuration(planned)})` : ""}.${total === 0 ? " Nessun tempo registrato: usa \"Registra tempo\" o completa i blocchi nella timeline." : ""}`,
        changed: false,
      };
    }

    case "remember": {
      const r = await db.from("assistant_memory").insert({ user_id: uid, kind: intent.kind, content: intent.content, source: "user" });
      if (r.error) throw new Error(r.error.message);
      return { reply: `Memorizzato (${intent.kind}). Puoi modificarlo o eliminarlo in Impostazioni › Memoria dell'assistente.`, changed: true };
    }
  }
}
