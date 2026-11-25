"use server";
import { z } from "zod";
import { num, optStr, run, str } from "@/lib/action";
import { must } from "@/lib/session";
import { planWake } from "@/lib/sleep";
import { addDays, zonedToUtc } from "@/lib/time";

export async function logSleep(fd: FormData) {
  await run("/sonno", async ({ db, user, profile, today }) => {
    const night = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch(addDays(today, -1)).parse(fd.get("night_of"));
    const bed = str(fd, "bedtime", 5);
    const wake = str(fd, "wake", 5);
    const tz = profile.timezone;
    const bedtime = /^\d{2}:\d{2}$/.test(bed) ? zonedToUtc(bed >= "12:00" ? night : addDays(night, 1), bed, tz).toISOString() : null;
    const wakeTime = /^\d{2}:\d{2}$/.test(wake) ? zonedToUtc(addDays(night, 1), wake, tz).toISOString() : null;
    const hours = num(fd, "hours");
    if (bedtime && wakeTime && wakeTime <= bedtime) throw new Error("La sveglia deve essere successiva al coricarsi");
    if (!bedtime && !wakeTime && hours == null) throw new Error("Inserisci orari o ore dormite");
    must(await db.from("sleep_logs").upsert({
      user_id: user.id, night_of: night, bedtime, wake_time: wakeTime, slept_minutes: hours != null ? Math.round(Math.min(20, Math.max(0, hours)) * 60) : null,
      quality: num(fd, "quality"), note: optStr(fd, "note", 500), source: str(fd, "import_source", 60) ? "import" : "manual", import_source: optStr(fd, "import_source", 60),
    }, { onConflict: "user_id,night_of" }));
    return "Notte registrata";
  });
}

export async function planWakeAction(fd: FormData) {
  await run("/sonno", async ({ db, user, profile, today }) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch(addDays(today, 1)).parse(fd.get("date"));
    const wake = z.string().regex(/^\d{2}:\d{2}$/).parse(fd.get("wake"));
    const mech = z.enum(["reminder", "calendar", "native_manual"]).catch("reminder").parse(fd.get("mechanism"));
    const p = planWake(date, wake, profile.sleep_goal_minutes);
    must(await db.from("wake_plans").upsert({
      user_id: user.id, for_date: date, wake_at: zonedToUtc(date, wake, profile.timezone).toISOString(),
      bedtime_target: zonedToUtc(p.bedDate, p.bedtime, profile.timezone).toISOString(), mechanism: mech,
    }, { onConflict: "user_id,for_date" }));
    return `Sveglia ${wake}: per ${Math.round(profile.sleep_goal_minutes / 6) / 10} h di sonno vai a letto alle ${p.bedtime}. ${mech === "native_manual" || mech === "reminder" ? "Imposta la sveglia nell'app Orologio del telefono." : "Verra' creato un evento con avviso se Google Calendar e' collegato."}`;
  });
}
