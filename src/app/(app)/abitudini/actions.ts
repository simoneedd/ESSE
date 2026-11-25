"use server";
import { z } from "zod";
import { isLifeArea } from "@/lib/domain";
import { run, safeBack, str } from "@/lib/action";
import { must } from "@/lib/session";

export async function toggleHabit(fd: FormData) {
  const back = safeBack(fd.get("back"), "/abitudini");
  await run(back, async ({ db, user }) => {
    const habit = z.uuid().parse(fd.get("habit_id"));
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("date"));
    const { data } = await db.from("habit_logs").select("id").eq("habit_id", habit).eq("log_date", date).maybeSingle();
    if (data) must(await db.from("habit_logs").delete().eq("id", data.id));
    else must(await db.from("habit_logs").insert({ user_id: user.id, habit_id: habit, log_date: date }));
    return data ? "Abitudine segnata come da fare" : "Abitudine completata";
  });
}

export async function addHabit(fd: FormData) {
  await run("/abitudini", async ({ db, user }) => {
    const name = str(fd, "name", 80);
    if (!name) throw new Error("Nome obbligatorio");
    const area = str(fd, "area", 20);
    const target = z.coerce.number().int().min(1).max(7).catch(7).parse(fd.get("target_per_week"));
    must(await db.from("habits").insert({ user_id: user.id, name, area: isLifeArea(area) ? area : "personal", target_per_week: target }));
    return "Abitudine aggiunta";
  });
}

export async function archiveHabit(fd: FormData) {
  await run("/abitudini", async ({ db }) => {
    must(await db.from("habits").update({ active: false }).eq("id", z.uuid().parse(fd.get("id"))));
    return "Abitudine archiviata";
  });
}
