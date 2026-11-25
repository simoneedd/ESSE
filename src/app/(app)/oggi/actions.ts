"use server";
import { z } from "zod";
import { num, optStr, run, safeBack, str } from "@/lib/action";
import { isLifeArea } from "@/lib/domain";
import { planAndSave } from "@/lib/plan-service";
import { must } from "@/lib/session";
import { addDays, zonedToUtc } from "@/lib/time";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function planDayAction(fd: FormData) {
  const date = dateSchema.parse(fd.get("date"));
  await run(`/oggi?d=${date}`, async ({ db, profile }) => {
    const { plan, saved } = await planAndSave(db, profile, date, "user");
    return `Piano generato: ${saved.blocks} blocchi${plan.overloaded ? `, ${plan.unscheduled.length} attivita' non entrano (vedi proposte)` : ""}`;
  });
}

/** Esito di un blocco: aggiorna stato, registra il tempo effettivo e, per le task, il loro stato. */
export async function setBlockStatus(fd: FormData) {
  const back = safeBack(fd.get("back"), "/oggi");
  await run(back, async ({ db, user }) => {
    const id = z.uuid().parse(fd.get("id"));
    const status = z.enum(["done", "partial", "skipped", "planned"]).parse(fd.get("status"));
    const block = must(await db.from("schedule_blocks").select("id, starts_at, ends_at, area, task_id, title").eq("id", id).single());
    const planned = Math.round((Date.parse(block.ends_at) - Date.parse(block.starts_at)) / 60000);
    const actual = status === "done" ? (num(fd, "actual") ?? planned) : status === "partial" ? (num(fd, "actual") ?? Math.round(planned / 2)) : null;
    must(await db.from("schedule_blocks").update({ status, actual_minutes: actual }).eq("id", id));
    if (actual) {
      let clientId: string | null = null;
      if (block.task_id) clientId = (await db.from("tasks").select("client_id").eq("id", block.task_id).maybeSingle()).data?.client_id ?? null;
      must(await db.from("time_entries").insert({ user_id: user.id, area: block.area, task_id: block.task_id, block_id: id, client_id: clientId, started_at: block.starts_at, minutes: Math.max(1, Math.min(1440, Math.round(actual))) }));
    }
    if (block.task_id && status === "done" && fd.get("complete_task") === "1") {
      // per le task IronEdge questo genera la voce di outbox: lo stato arrivera' al gestionale
      must(await db.from("tasks").update({ status: "done" }).eq("id", block.task_id));
    }
    return status === "done" ? "Segnato come fatto" : status === "partial" ? "Segnato come parziale" : status === "skipped" ? "Segnato come non svolto" : "Ripristinato";
  });
}

export async function decideProposal(fd: FormData) {
  const back = safeBack(fd.get("back"), "/oggi");
  await run(back, async ({ db, profile }) => {
    const id = z.uuid().parse(fd.get("id"));
    const approve = fd.get("decision") === "approve";
    const p = must(await db.from("plan_proposals").select("kind, payload").eq("id", id).single());
    must(await db.rpc("decide_proposal", { p_id: id, p_approve: approve }));
    if (!approve) return "Proposta rifiutata: nessuna modifica";
    if (p.kind === "reschedule_task") {
      const payload = z.object({ taskIds: z.array(z.uuid()), toDate: dateSchema }).parse(p.payload);
      const { data: tasks } = await db.from("tasks").select("id, source, due_at, postponed_count").in("id", payload.taskIds);
      for (const t of tasks ?? []) {
        const patch: Record<string, unknown> = { postponed_count: t.postponed_count + 1 };
        // la scadenza delle task IronEdge resta quella del gestionale (fonte autorevole)
        if (t.source === "local" && t.due_at && t.due_at < zonedToUtc(payload.toDate, "00:00", profile.timezone).toISOString()) patch.due_at = zonedToUtc(payload.toDate, "23:59", profile.timezone).toISOString();
        must(await db.from("tasks").update(patch).eq("id", t.id));
      }
      await planAndSave(db, profile, payload.toDate, "user");
      await db.from("plan_proposals").update({ status: "applied" }).eq("id", id);
      return "Approvata: attivita' spostate a domani e piano aggiornato";
    }
    return "Approvata. Gli impegni fissi vanno spostati manualmente o nel calendario d'origine: Personal OS non modifica riunioni con altre persone.";
  });
}

export async function addEvent(fd: FormData) {
  const date = dateSchema.parse(fd.get("date"));
  await run(`/oggi?d=${date}`, async ({ db, user, profile }) => {
    const title = str(fd, "title", 200);
    if (!title) throw new Error("Titolo obbligatorio");
    const start = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("start"));
    const end = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("end"));
    const area = str(fd, "area", 20);
    let endsDate = date;
    if (end <= start) endsDate = addDays(date, 1);
    must(
      await db.from("events").insert({
        user_id: user.id,
        title,
        area: isLifeArea(area) ? area : "personal",
        starts_at: zonedToUtc(date, start, profile.timezone).toISOString(),
        ends_at: zonedToUtc(endsDate, end, profile.timezone).toISOString(),
        involves_others: fd.get("involves_others") === "on",
        is_external: fd.get("is_external") === "on",
        travel_before_minutes: Math.min(240, Math.max(0, num(fd, "travel") ?? 0)),
        travel_after_minutes: Math.min(240, Math.max(0, num(fd, "travel") ?? 0)),
        location: optStr(fd, "location", 200),
        kind: fd.get("involves_others") === "on" ? "meeting" : "appointment",
      }),
    );
    if (fd.get("replan") === "on") await planAndSave(db, profile, date, "user");
    return fd.get("replan") === "on" ? "Impegno aggiunto e attivita' flessibili ripianificate" : "Impegno aggiunto";
  });
}

export async function deleteEvent(fd: FormData) {
  const back = safeBack(fd.get("back"), "/oggi");
  await run(back, async ({ db }) => {
    const id = z.uuid().parse(fd.get("id"));
    const ev = must(await db.from("events").select("origin, involves_others").eq("id", id).single());
    if (ev.origin === "google") throw new Error("Evento importato da Google: eliminalo da Google Calendar (Personal OS non elimina eventi altrui).");
    if (ev.involves_others && fd.get("confirm") !== "1") throw new Error("Riunione con altre persone: conferma esplicita richiesta.");
    must(await db.from("events").delete().eq("id", id));
    return "Impegno eliminato in Personal OS (eventuale copia su Google Calendar non viene cancellata automaticamente)";
  });
}
