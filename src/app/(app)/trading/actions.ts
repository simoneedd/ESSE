"use server";
import { z } from "zod";
import { optStr, run, safeBack, str } from "@/lib/action";
import { must } from "@/lib/session";
import { addDays, zonedToUtc } from "@/lib/time";

const KINDS = ["operative_session", "market_analysis", "chart_prep", "macro_event", "meeting", "ironedge_activity", "tiktok_live", "webinar", "lesson"] as const;

export async function addTradingSession(fd: FormData) {
  await run("/trading", async ({ db, user, profile }) => {
    const kind = z.enum(KINDS).parse(fd.get("kind"));
    const title = str(fd, "title", 200);
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(fd.get("date"));
    const start = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("start"));
    const end = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("end"));
    if (!title) throw new Error("Titolo obbligatorio");
    const repeat = z.coerce.number().int().min(1).max(12).catch(1).parse(fd.get("repeat_weeks"));
    const rows = Array.from({ length: repeat }, (_, i) => {
      const d = addDays(date, i * 7);
      return {
        user_id: user.id, kind, title, instrument: optStr(fd, "instrument", 40), notes: optStr(fd, "notes", 4000),
        starts_at: zonedToUtc(d, start, profile.timezone).toISOString(), ends_at: zonedToUtc(end > start ? d : addDays(d, 1), end, profile.timezone).toISOString(),
        // appuntamenti macro, webinar, live e lezioni hanno orari pubblici: fissi per lo scheduler
        fixed: fd.get("fixed") === "on" || ["macro_event", "webinar", "tiktok_live", "lesson", "meeting"].includes(kind),
      };
    });
    must(await db.from("trading_sessions").insert(rows));
    return repeat > 1 ? `${repeat} sessioni settimanali aggiunte` : "Sessione aggiunta";
  });
}

export async function setTradingStatus(fd: FormData) {
  const back = safeBack(fd.get("back"), "/trading");
  await run(back, async ({ db }) => {
    must(await db.from("trading_sessions").update({ status: z.enum(["planned", "done", "skipped"]).parse(fd.get("status")) }).eq("id", z.uuid().parse(fd.get("id"))));
    return "Aggiornato";
  });
}

export async function deleteTradingSession(fd: FormData) {
  await run("/trading", async ({ db }) => {
    must(await db.from("trading_sessions").delete().eq("id", z.uuid().parse(fd.get("id"))));
    return "Eliminata";
  });
}
