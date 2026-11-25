"use server";
import { z } from "zod";
import { num, optStr, run, str } from "@/lib/action";
import { must } from "@/lib/session";
import { zonedToUtc } from "@/lib/time";

export async function addTemplate(fd: FormData) {
  await run("/palestra", async ({ db, user }) => {
    const name = str(fd, "name", 120);
    if (!name) throw new Error("Nome obbligatorio");
    must(await db.from("workout_templates").insert({ user_id: user.id, name, focus: optStr(fd, "focus", 120), estimated_minutes: Math.min(300, Math.max(10, num(fd, "minutes") ?? 60)) }));
    return "Scheda creata";
  });
}

export async function addExercise(fd: FormData) {
  await run("/palestra", async ({ db, user }) => {
    const templateId = z.uuid().parse(fd.get("template_id"));
    const exercise = str(fd, "exercise", 120);
    if (!exercise) throw new Error("Esercizio obbligatorio");
    const { count } = await db.from("template_exercises").select("id", { count: "exact", head: true }).eq("template_id", templateId);
    must(await db.from("template_exercises").insert({
      user_id: user.id, template_id: templateId, position: count ?? 0, exercise, sets: Math.min(20, Math.max(1, num(fd, "sets") ?? 3)), reps: str(fd, "reps", 20) || "10",
      load_kg: num(fd, "load"), rest_seconds: num(fd, "rest"), notes: optStr(fd, "notes", 300),
    }));
    return "Esercizio aggiunto";
  });
}

export async function removeExercise(fd: FormData) {
  await run("/palestra", async ({ db }) => {
    must(await db.from("template_exercises").delete().eq("id", z.uuid().parse(fd.get("id"))));
    return "Esercizio rimosso";
  });
}

export async function planWorkout(fd: FormData) {
  await run("/palestra", async ({ db, user, profile }) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("date"));
    const rest = fd.get("rest_day") === "on";
    must(await db.from("workout_sessions").insert({
      user_id: user.id, template_id: rest ? null : (z.uuid().safeParse(fd.get("template_id")).data ?? null),
      planned_for: zonedToUtc(date, str(fd, "time", 5) || "18:00", profile.timezone).toISOString(), status: rest ? "rest_day" : "planned",
    }));
    return rest ? "Giorno di riposo segnato" : "Allenamento pianificato";
  });
}

/** Registra un allenamento svolto: serie effettive (una riga per esercizio: serie x ripetizioni @ carico). */
export async function logWorkout(fd: FormData) {
  await run("/palestra", async ({ db, user, profile, today }) => {
    const sessionId = z.uuid().safeParse(fd.get("session_id")).data;
    const templateId = z.uuid().safeParse(fd.get("template_id")).data ?? null;
    const performed = zonedToUtc(str(fd, "date", 10) || today, str(fd, "time", 5) || "18:00", profile.timezone).toISOString();
    const duration = num(fd, "duration");
    const payload = { status: "done", performed_at: performed, duration_minutes: duration ? Math.round(duration) : null, perceived_effort: num(fd, "rpe"), note: optStr(fd, "note", 500) };
    const id = sessionId
      ? (must(await db.from("workout_sessions").update(payload).eq("id", sessionId).select("id").single())).id
      : (must(await db.from("workout_sessions").insert({ ...payload, user_id: user.id, template_id: templateId, planned_for: performed }).select("id").single())).id;
    const lines = str(fd, "sets", 4000).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40);
    const rows: Record<string, unknown>[] = [];
    for (const line of lines) {
      // formato: "Panca piana 4x8@60" oppure "Trazioni 3x10"
      const m = /^(.{1,120}?)\s+(\d{1,2})\s*[x×]\s*(\d{1,3})(?:\s*@\s*(\d{1,4}(?:[.,]\d{1,2})?))?$/i.exec(line);
      if (!m) throw new Error(`Riga non valida: "${line.slice(0, 40)}". Formato: Esercizio 4x8@60`);
      for (let s = 1; s <= Number(m[2]); s++) rows.push({ user_id: user.id, session_id: id, exercise: m[1], set_number: s, reps: Number(m[3]), load_kg: m[4] ? Number(m[4].replace(",", ".")) : null });
    }
    if (rows.length) must(await db.from("session_sets").insert(rows));
    if (duration) must(await db.from("time_entries").insert({ user_id: user.id, area: "gym", started_at: performed, minutes: Math.round(duration) }));
    return `Allenamento registrato (${rows.length} serie)`;
  });
}
