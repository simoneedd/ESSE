"use server";
import { z } from "zod";
import { num, run, str } from "@/lib/action";
import { CALENDAR_AREAS, LIFE_AREAS } from "@/lib/domain";
import { must } from "@/lib/session";

const time = z.string().regex(/^\d{2}:\d{2}$/);

export async function saveProfile(fd: FormData) {
  await run("/impostazioni", async ({ db, user, profile }) => {
    const sleepH = num(fd, "sleep_goal_hours") ?? profile.sleep_goal_minutes / 60;
    const areas = LIFE_AREAS.filter((a) => fd.get(`auto_${a}`) === "on");
    const schedule = {
      ...profile.schedule,
      morning_briefing: time.catch("07:45").parse(fd.get("morning_briefing")),
      evening_review: time.catch("21:30").parse(fd.get("evening_review")),
      bedtime_reminder_offset_min: z.coerce.number().int().min(0).max(180).catch(45).parse(fd.get("bedtime_offset")),
      weekly_report: time.catch("18:00").parse(fd.get("weekly_report")),
      weekly_report_dow: z.coerce.number().int().min(1).max(7).catch(7).parse(fd.get("weekly_report_dow")),
      monthly_report_day: z.coerce.number().int().min(1).max(28).catch(1).parse(fd.get("monthly_report_day")),
      task_reminder_min: z.coerce.number().int().min(0).max(120).catch(10).parse(fd.get("task_reminder_min")),
    };
    const tz = str(fd, "timezone", 60);
    let validTz = profile.timezone;
    try {
      new Intl.DateTimeFormat("it-IT", { timeZone: tz });
      validTz = tz || profile.timezone;
    } catch {
      /* fuso non valido: si mantiene il precedente */
    }
    must(await db.from("profiles").update({
      display_name: str(fd, "display_name", 80) || null,
      timezone: validTz,
      sleep_goal_minutes: Math.round(Math.min(12, Math.max(4, sleepH)) * 60),
      target_bedtime: time.parse(fd.get("target_bedtime")),
      target_wake: time.parse(fd.get("target_wake")),
      workday_start: time.parse(fd.get("workday_start")),
      workday_end: time.parse(fd.get("workday_end")),
      max_work_minutes_per_day: Math.round(Math.min(16, Math.max(1, num(fd, "max_work_hours") ?? 9)) * 60),
      buffer_percent: Math.round(Math.min(50, Math.max(0, num(fd, "buffer_percent") ?? 15))),
      auto_reschedule_areas: areas,
      schedule,
    }).eq("user_id", user.id));
    return "Impostazioni salvate";
  });
}

export async function savePrivacy(fd: FormData) {
  await run("/impostazioni", async ({ db, user }) => {
    const chat = str(fd, "telegram_chat_id", 20);
    const optIn = fd.get("telegram_opt_in") === "on" && /^-?\d{3,20}$/.test(chat);
    must(await db.from("profiles").update({
      ai_consent: fd.get("ai_consent") === "on",
      ai_share_health: fd.get("ai_consent") === "on" && fd.get("ai_share_health") === "on",
      retention_days: z.coerce.number().int().min(30).max(3650).catch(730).parse(fd.get("retention_days")),
      telegram_opt_in: optIn,
      telegram_chat_id: optIn ? Number(chat) : null,
    }).eq("user_id", user.id));
    return "Preferenze privacy salvate";
  });
}

export async function saveMemory(fd: FormData) {
  await run("/impostazioni#memoria", async ({ db, user }) => {
    const id = z.uuid().safeParse(fd.get("id")).data;
    const content = str(fd, "content", 1000);
    const kind = z.enum(["preference", "decision", "fact", "constraint"]).catch("preference").parse(fd.get("kind"));
    if (fd.get("delete") === "1" && id) {
      must(await db.from("assistant_memory").delete().eq("id", id));
      return "Ricordo eliminato";
    }
    if (content.length < 3) throw new Error("Testo troppo breve");
    if (id) must(await db.from("assistant_memory").update({ content, kind, active: fd.get("active") !== "off" }).eq("id", id));
    else must(await db.from("assistant_memory").insert({ user_id: user.id, content, kind, source: "user" }));
    return "Memoria aggiornata";
  });
}

export async function saveCalendarMapping(fd: FormData) {
  await run("/impostazioni#integrazioni", async ({ db, user }) => {
    for (const area of CALENDAR_AREAS) {
      const cal = str(fd, `cal_${area}`, 300);
      if (!cal) {
        await db.from("calendar_mappings").delete().eq("area", area);
        continue;
      }
      must(await db.from("calendar_mappings").upsert({ user_id: user.id, area, gcal_calendar_id: cal, read_enabled: fd.get(`read_${area}`) === "on", write_enabled: fd.get(`write_${area}`) === "on" }, { onConflict: "user_id,area" }));
    }
    return "Calendari salvati";
  });
}

export async function disconnectGoogle() {
  await run("/impostazioni#integrazioni", async ({ db }) => {
    // il token si trova in una tabella senza accesso client: la revoca passa dalla route server
    await db.from("calendar_mappings").update({ read_enabled: false, write_enabled: false, sync_token: null }).neq("area", "health");
    return "Sincronizzazione Google sospesa. Per rimuovere del tutto l'accesso usa anche https://myaccount.google.com/permissions";
  });
}

export async function deleteAllData(fd: FormData) {
  await run("/impostazioni", async ({ db }) => {
    if (str(fd, "confirm", 20) !== "ELIMINA TUTTO") throw new Error('Scrivi esattamente "ELIMINA TUTTO" per confermare');
    must(await db.rpc("delete_my_data", { p_confirm: "ELIMINA TUTTO" }));
    return "Tutti i dati sono stati eliminati (il profilo verra' ricreato vuoto al prossimo accesso)";
  });
}
