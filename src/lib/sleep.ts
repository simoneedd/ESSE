/**
 * Analisi del sonno (solo dati inseriti dall'utente o importati da fonti autorizzate).
 * Nessuna diagnosi: indicatori descrittivi e suggerimenti di igiene del sonno generici.
 */
import { addDays, hhmmToMinutes, minutesToHhmm, zonedParts } from "./time";

export type SleepLog = { night_of: string; bedtime: string | null; wake_time: string | null; slept_minutes: number | null; quality?: number | null };

/** Minuti dormiti: valore esplicito, altrimenti differenza coricarsi/sveglia. */
export function sleptMinutes(l: SleepLog): number | null {
  if (l.slept_minutes != null) return l.slept_minutes;
  if (l.bedtime && l.wake_time) {
    const d = (Date.parse(l.wake_time) - Date.parse(l.bedtime)) / 60_000;
    return d > 0 && d < 20 * 60 ? Math.round(d) : null;
  }
  return null;
}

/** Orario come minuti "centrati" sulla notte (18:00 -> -360, 01:00 -> 60) per medie corrette a cavallo della mezzanotte. */
function nightMinutes(iso: string, tz: string): number {
  const p = zonedParts(new Date(iso), tz);
  const m = p.hour * 60 + p.minute;
  return m >= 18 * 60 ? m - 1440 : m;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs: number[]) => {
  const m = mean(xs);
  if (m == null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export type SleepStats = {
  nights: number;
  avgMinutes: number | null;
  goalMinutes: number;
  nightsBelowGoal: number;
  debtMinutes: number; // somma dei deficit (solo notti registrate)
  avgBedtime: string | null;
  avgWake: string | null;
  bedtimeSdMinutes: number | null;
  wakeSdMinutes: number | null;
  regularity: "alta" | "media" | "bassa" | "dati insufficienti";
  weekendShiftMinutes: number | null; // differenza media sveglia weekend vs feriali
};

export function sleepStats(logs: SleepLog[], goalMinutes: number, tz: string): SleepStats {
  const mins = logs.map(sleptMinutes).filter((x): x is number => x != null);
  const beds = logs.filter((l) => l.bedtime).map((l) => nightMinutes(l.bedtime!, tz));
  const wakes = logs.filter((l) => l.wake_time).map((l) => nightMinutes(l.wake_time!, tz));
  const bsd = sd(beds);
  const wsd = sd(wakes);
  const spread = bsd != null && wsd != null ? (bsd + wsd) / 2 : (bsd ?? wsd);
  const regularity = spread == null || logs.length < 4 ? "dati insufficienti" : spread <= 30 ? "alta" : spread <= 60 ? "media" : "bassa";
  const weekend: number[] = [];
  const weekday: number[] = [];
  for (const l of logs) {
    if (!l.wake_time) continue;
    const wd = zonedParts(new Date(l.wake_time), tz).weekday;
    (wd >= 6 ? weekend : weekday).push(nightMinutes(l.wake_time, tz));
  }
  const we = mean(weekend);
  const wk = mean(weekday);
  const avgBed = mean(beds);
  const avgWake = mean(wakes);
  return {
    nights: logs.length,
    avgMinutes: mean(mins) == null ? null : Math.round(mean(mins)!),
    goalMinutes,
    nightsBelowGoal: mins.filter((m) => m < goalMinutes).length,
    debtMinutes: mins.reduce((a, m) => a + Math.max(0, goalMinutes - m), 0),
    avgBedtime: avgBed == null ? null : minutesToHhmm(avgBed),
    avgWake: avgWake == null ? null : minutesToHhmm(avgWake),
    bedtimeSdMinutes: bsd == null ? null : Math.round(bsd),
    wakeSdMinutes: wsd == null ? null : Math.round(wsd),
    regularity,
    weekendShiftMinutes: we != null && wk != null ? Math.round(we - wk) : null,
  };
}

export function sleepSuggestions(s: SleepStats): string[] {
  const out: string[] = [];
  if (s.nights < 4) return ["Registra almeno 4 notti per un'analisi della regolarita'."];
  if (s.avgMinutes != null && s.avgMinutes < s.goalMinutes - 30) {
    out.push(`Media di ${Math.round((s.avgMinutes / 60) * 10) / 10} h, sotto l'obiettivo di ${Math.round((s.goalMinutes / 60) * 10) / 10} h: anticipa gradualmente il coricarsi di 15 minuti ogni 2-3 giorni.`);
  }
  if (s.regularity === "bassa") out.push("Orari molto variabili: mantenere coricarsi e sveglia entro 30 minuti anche nel weekend favorisce la regolarita'.");
  if (s.weekendShiftMinutes != null && s.weekendShiftMinutes > 60) out.push(`Nel weekend ti svegli in media ${s.weekendShiftMinutes} min piu' tardi: riduci la differenza per limitare il "jet lag sociale".`);
  if (!out.length) out.push("Sonno in linea con l'obiettivo: mantieni la routine attuale.");
  out.push("Indicazioni generali, non mediche: per disturbi persistenti rivolgiti a un professionista.");
  return out;
}

/**
 * Pianificazione della sveglia: dato l'orario di sveglia, propone il coricarsi per rispettare
 * l'obiettivo (+ tempo di addormentamento). Restituisce anche il meccanismo realmente disponibile.
 */
export function planWake(forDate: string, wake: string, goalMinutes: number, fallAsleepMinutes = 15) {
  const wakeMin = hhmmToMinutes(wake);
  const bedMin = wakeMin - goalMinutes - fallAsleepMinutes;
  const bedDate = bedMin < 0 ? addDays(forDate, -1) : forDate;
  return {
    forDate,
    wake,
    bedtime: minutesToHhmm(bedMin),
    bedDate,
    reminderAt: minutesToHhmm(bedMin - 45),
    note:
      "Personal OS invia promemoria e puo' creare un evento con avviso su Google Calendar, ma NON puo' attivare la sveglia nativa del telefono: impostala tu dall'app Orologio.",
  };
}
