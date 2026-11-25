"use server";
import { z } from "zod";
import { num, optStr, run, str } from "@/lib/action";
import { nextReview } from "@/lib/planning";
import { must } from "@/lib/session";
import { zonedToUtc } from "@/lib/time";

export async function addStudyItem(fd: FormData) {
  await run("/studio", async ({ db, user }) => {
    const title = str(fd, "title", 200);
    if (!title) throw new Error("Titolo obbligatorio");
    const due = str(fd, "due", 10);
    const weekly = num(fd, "weekly_hours");
    const total = num(fd, "total_units");
    must(await db.from("study_items").insert({
      user_id: user.id, title, kind: z.enum(["course", "subject", "book"]).catch("course").parse(fd.get("kind")), author: optStr(fd, "author", 120), goal: optStr(fd, "goal", 500),
      total_units: total ? Math.round(total) : null, weekly_target_minutes: weekly != null ? Math.round(weekly * 60) : null, due_date: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    }));
    return "Aggiunto";
  });
}

export async function logStudySession(fd: FormData) {
  await run("/studio", async ({ db, user, profile, today }) => {
    const focus = num(fd, "focus");
    if (!focus || focus < 1 || focus > 600) throw new Error("Minuti di concentrazione non validi");
    const itemId = z.uuid().safeParse(fd.get("item_id")).data ?? null;
    const units = num(fd, "units");
    must(await db.from("study_sessions").insert({
      user_id: user.id, item_id: itemId, started_at: zonedToUtc(str(fd, "date", 10) || today, str(fd, "time", 5) || "18:00", profile.timezone).toISOString(),
      focus_minutes: Math.round(focus), break_minutes: Math.round(num(fd, "breaks") ?? 0), pomodoros: Math.round(focus / 25), units_done: units ? Math.round(units) : null,
    }));
    if (itemId && units) {
      const it = must(await db.from("study_items").select("done_units, total_units").eq("id", itemId).single());
      const done = Math.min(it.total_units ?? Number.MAX_SAFE_INTEGER, it.done_units + Math.round(units));
      must(await db.from("study_items").update({ done_units: done }).eq("id", itemId));
    }
    must(await db.from("time_entries").insert({ user_id: user.id, area: "study", started_at: zonedToUtc(str(fd, "date", 10) || today, str(fd, "time", 5) || "18:00", profile.timezone).toISOString(), minutes: Math.round(focus) }));
    return "Sessione registrata";
  });
}

export async function addNote(fd: FormData) {
  await run("/studio", async ({ db, user, today }) => {
    const title = str(fd, "title", 200);
    if (!title) throw new Error("Titolo obbligatorio");
    const r = nextReview(0, today, true);
    must(await db.from("study_notes").insert({ user_id: user.id, item_id: z.uuid().safeParse(fd.get("item_id")).data ?? null, title, body: optStr(fd, "body", 20000), review_stage: r.stage, next_review_on: r.next }));
    return "Appunto salvato: primo ripasso domani";
  });
}

export async function reviewNote(fd: FormData) {
  await run("/studio", async ({ db, today }) => {
    const id = z.uuid().parse(fd.get("id"));
    const note = must(await db.from("study_notes").select("review_stage").eq("id", id).single());
    const r = nextReview(note.review_stage, today, fd.get("remembered") === "1");
    must(await db.from("study_notes").update({ review_stage: r.stage, next_review_on: r.next }).eq("id", id));
    return `Prossimo ripasso: ${r.next}`;
  });
}
