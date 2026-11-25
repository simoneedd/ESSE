"use server";
import { z } from "zod";
import { num, optStr, run, safeBack, str } from "@/lib/action";
import { must } from "@/lib/session";
import { zonedToUtc } from "@/lib/time";

export async function createClientAction(fd: FormData) {
  await run("/marketing", async ({ db, user }) => {
    const name = str(fd, "name", 120);
    if (!name) throw new Error("Nome obbligatorio");
    const color = str(fd, "color", 7);
    const target = num(fd, "weekly_hours");
    must(await db.from("clients").insert({
      user_id: user.id, name, priority: z.coerce.number().int().min(1).max(4).catch(2).parse(fd.get("priority")),
      weekly_target_minutes: target != null ? Math.round(Math.min(100, Math.max(0, target)) * 60) : null,
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : null, contact_notes: optStr(fd, "notes", 4000),
    }), "Cliente non creato (nome gia' esistente?)");
    return "Cliente aggiunto";
  });
}

export async function updateClient(fd: FormData) {
  const id = z.uuid().parse(fd.get("id"));
  await run(`/marketing/${id}`, async ({ db }) => {
    const target = num(fd, "weekly_hours");
    must(await db.from("clients").update({
      priority: z.coerce.number().int().min(1).max(4).catch(2).parse(fd.get("priority")),
      weekly_target_minutes: target != null ? Math.round(Math.min(100, Math.max(0, target)) * 60) : null,
      contact_notes: optStr(fd, "notes", 4000), active: fd.get("active") === "on",
    }).eq("id", id));
    return "Scheda aggiornata";
  });
}

export async function createProject(fd: FormData) {
  const clientId = z.uuid().parse(fd.get("client_id"));
  await run(`/marketing/${clientId}`, async ({ db, user }) => {
    const name = str(fd, "name", 160);
    if (!name) throw new Error("Nome obbligatorio");
    const due = str(fd, "due", 10);
    must(await db.from("projects").insert({ user_id: user.id, client_id: clientId, name, area: "marketing", due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null }));
    return "Progetto creato";
  });
}

export async function setProjectStatus(fd: FormData) {
  const back = safeBack(fd.get("back"), "/marketing");
  await run(back, async ({ db }) => {
    must(await db.from("projects").update({ status: z.enum(["active", "paused", "done", "archived"]).parse(fd.get("status")) }).eq("id", z.uuid().parse(fd.get("id"))));
    return "Progetto aggiornato";
  });
}

export async function logTime(fd: FormData) {
  const back = safeBack(fd.get("back"), "/marketing");
  await run(back, async ({ db, user, profile, today }) => {
    const minutes = num(fd, "minutes");
    if (!minutes || minutes < 1 || minutes > 1440) throw new Error("Minuti non validi");
    const date = str(fd, "date", 10) || today;
    const area = z.enum(["personal", "marketing", "trading", "ironedge", "gym", "study", "health"]).catch("marketing").parse(fd.get("area"));
    must(await db.from("time_entries").insert({
      user_id: user.id, area, client_id: z.uuid().safeParse(fd.get("client_id")).data ?? null,
      started_at: zonedToUtc(date, str(fd, "time", 5) || "09:00", profile.timezone).toISOString(), minutes: Math.round(minutes), note: optStr(fd, "note", 500),
    }));
    return "Tempo registrato";
  });
}

export async function addMeeting(fd: FormData) {
  const clientId = z.uuid().parse(fd.get("client_id"));
  await run(`/marketing/${clientId}`, async ({ db, user, profile }) => {
    const title = str(fd, "title", 200);
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("date"));
    const start = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("start"));
    const end = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("end"));
    if (!title || end <= start) throw new Error("Titolo e orari validi obbligatori");
    must(await db.from("events").insert({
      user_id: user.id, client_id: clientId, area: "marketing", title, kind: "meeting", involves_others: fd.get("others") === "on", is_external: fd.get("others") === "on",
      starts_at: zonedToUtc(date, start, profile.timezone).toISOString(), ends_at: zonedToUtc(date, end, profile.timezone).toISOString(),
    }));
    return "Riunione/appuntamento aggiunto";
  });
}
