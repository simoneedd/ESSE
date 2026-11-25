"use server";
import { z } from "zod";
import { num, optStr, run, safeBack, str } from "@/lib/action";
import { isLifeArea } from "@/lib/domain";
import { must } from "@/lib/session";
import { zonedToUtc } from "@/lib/time";

export async function createTask(fd: FormData) {
  const back = safeBack(fd.get("back"), "/task");
  await run(back, async ({ db, user, profile }) => {
    const title = str(fd, "title", 200);
    if (!title) throw new Error("Titolo obbligatorio");
    const area = str(fd, "area", 20);
    const due = str(fd, "due", 10);
    const auto = str(fd, "auto", 5);
    must(
      await db.from("tasks").insert({
        user_id: user.id,
        title,
        description: optStr(fd, "description", 8000),
        area: isLifeArea(area) ? area : "personal",
        priority: z.coerce.number().int().min(1).max(4).catch(3).parse(fd.get("priority")),
        estimated_minutes: (() => { const n = num(fd, "estimated"); return n ? Math.min(1440, Math.max(5, Math.round(n))) : null; })(),
        due_at: /^\d{4}-\d{2}-\d{2}$/.test(due) ? zonedToUtc(due, str(fd, "due_time", 5) || "23:59", profile.timezone).toISOString() : null,
        category: optStr(fd, "category", 80),
        client_id: z.uuid().safeParse(fd.get("client_id")).data ?? null,
        project_id: z.uuid().safeParse(fd.get("project_id")).data ?? null,
        flexibility: fd.get("fixed") === "on" ? "fixed" : "flexible",
        auto_reschedule: auto === "yes" ? true : auto === "no" ? false : null,
        recurrence: ["daily", "weekdays", "weekly", "monthly"].includes(str(fd, "recurrence", 10)) ? str(fd, "recurrence", 10) : null,
      }),
    );
    return "Task creata";
  });
}

export async function setTaskStatus(fd: FormData) {
  const back = safeBack(fd.get("back"), "/task");
  await run(back, async ({ db }) => {
    const id = z.uuid().parse(fd.get("id"));
    const status = z.enum(["todo", "in_progress", "done", "skipped", "cancelled"]).parse(fd.get("status"));
    must(await db.from("tasks").update({ status }).eq("id", id));
    const t = (await db.from("tasks").select("source").eq("id", id).single()).data;
    return t?.source === "ironedge" ? "Stato aggiornato: verra' sincronizzato con IronEdge" : "Stato aggiornato";
  });
}

export async function setTaskAutonomy(fd: FormData) {
  const back = safeBack(fd.get("back"), "/task");
  await run(back, async ({ db }) => {
    const id = z.uuid().parse(fd.get("id"));
    const v = str(fd, "auto", 5);
    must(await db.from("tasks").update({ auto_reschedule: v === "yes" ? true : v === "no" ? false : null }).eq("id", id));
    return "Autonomia aggiornata";
  });
}

export async function deleteTask(fd: FormData) {
  const back = safeBack(fd.get("back"), "/task");
  await run(back, async ({ db }) => {
    must(await db.from("tasks").delete().eq("id", z.uuid().parse(fd.get("id"))));
    return "Task eliminata";
  });
}
