/**
 * Pianificazione settimanale di palestra e studio, ripasso dilazionato, import piano alimentare.
 */
import { z } from "zod";
import type { FixedItem } from "./scheduler/engine";
import { addDays, zonedParts, zonedToUtc } from "./time";

// ---------------------------------------------------------------------------
// Palestra: distribuzione di N allenamenti nella settimana con recupero
// ---------------------------------------------------------------------------
export type DayLoad = { date: string; busyMinutes: number; fixedWorkMinutes: number; restDay?: boolean; hasWorkout?: boolean };

/**
 * Sceglie i giorni per N allenamenti:
 *  - mai due giorni consecutivi se N <= 4 (recupero), al massimo 2 consecutivi se N > 4;
 *  - preferisce i giorni meno carichi di lavoro;
 *  - rispetta i giorni di riposo indicati dall'utente.
 */
export function pickWorkoutDays(days: DayLoad[], count: number): { chosen: string[]; warning?: string } {
  const maxConsecutive = count <= 4 ? 1 : 2;
  const fixedDays = days.filter((d) => d.hasWorkout).map((d) => d.date);
  const free = days.filter((d) => !d.restDay && !d.hasWorkout).slice(0, 14);
  const runOk = (set: Set<string>) => {
    for (const d of set) {
      let run = 1;
      for (let i = 1; set.has(addDays(d, i)); i++) run++;
      if (run > maxConsecutive) return false;
    }
    return true;
  };
  const need = Math.max(0, count - fixedDays.length);
  // ricerca esatta (al massimo 2^14 combinazioni): massimo numero di sedute valide, poi carico minimo
  let best: { pick: DayLoad[]; load: number } = { pick: [], load: 0 };
  const n = free.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const pick = free.filter((_, i) => mask & (1 << i));
    if (pick.length > need) continue;
    const set = new Set([...fixedDays, ...pick.map((p) => p.date)]);
    if (!runOk(set)) continue;
    const load = pick.reduce((a, p) => a + p.busyMinutes, 0);
    if (pick.length > best.pick.length || (pick.length === best.pick.length && load < best.load)) best = { pick, load };
  }
  const result = [...fixedDays, ...best.pick.map((p) => p.date)].sort();
  return result.length < count
    ? { chosen: result, warning: `Pianificati ${result.length} allenamenti su ${count}: i giorni disponibili non consentono il recupero tra le sedute.` }
    : { chosen: result };
}

// ---------------------------------------------------------------------------
// Studio: ripasso dilazionato e sessioni di concentrazione
// ---------------------------------------------------------------------------
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60];

export function nextReview(stage: number, today: string, remembered: boolean): { stage: number; next: string } {
  const s = remembered ? Math.min(stage + 1, REVIEW_INTERVALS.length) : 0;
  return { stage: s, next: addDays(today, REVIEW_INTERVALS[Math.max(0, s - 1)] ?? 1) };
}

/** Sessione di concentrazione: cicli focus/pausa (default 25/5, pausa lunga ogni 4). */
export function focusPlan(totalMinutes: number, focus = 25, shortBreak = 5, longBreak = 15) {
  const parts: { kind: "focus" | "break"; minutes: number }[] = [];
  let left = totalMinutes;
  let cycles = 0;
  while (left > 0) {
    const f = Math.min(focus, left);
    parts.push({ kind: "focus", minutes: f });
    left -= f;
    cycles++;
    if (left <= 0) break;
    const b = cycles % 4 === 0 ? longBreak : shortBreak;
    parts.push({ kind: "break", minutes: Math.min(b, left) });
    left -= b;
  }
  return { parts, focusMinutes: parts.filter((p) => p.kind === "focus").reduce((a, p) => a + p.minutes, 0) };
}

export function progressPercent(done: number, total: number | null): number | null {
  if (!total) return null;
  return Math.round(Math.min(100, (done / total) * 100));
}

// ---------------------------------------------------------------------------
// Alimentazione: import di un piano redatto da un professionista (nessuna generazione)
// ---------------------------------------------------------------------------
const slotMap: Record<string, "breakfast" | "lunch" | "dinner" | "snack"> = {
  colazione: "breakfast",
  breakfast: "breakfast",
  pranzo: "lunch",
  lunch: "lunch",
  cena: "dinner",
  dinner: "dinner",
  spuntino: "snack",
  merenda: "snack",
  snack: "snack",
};
const dayMap: Record<string, number> = { lun: 1, mar: 2, mer: 3, gio: 4, ven: 5, sab: 6, dom: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

export const mealItemSchema = z.object({
  weekday: z.number().int().min(1).max(7).nullable(),
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  time_hint: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  description: z.string().min(1).max(1000),
});
export type MealItem = z.infer<typeof mealItemSchema>;

/**
 * CSV con intestazione: giorno;pasto;orario;descrizione  (giorno vuoto o "tutti" = ogni giorno).
 * Separatore ; o , . Righe non valide riportate come errori, mai inventate.
 */
export function parseMealPlanCsv(text: string): { items: MealItem[]; errors: string[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 500) return { items: [], errors: ["File troppo lungo (max 500 righe)"] };
  const sep = (lines[0] ?? "").includes(";") ? ";" : ",";
  const header = (lines.shift() ?? "").toLowerCase().split(sep).map((h) => h.trim());
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iDay = idx(["giorno", "day"]);
  const iSlot = idx(["pasto", "meal", "slot"]);
  const iTime = idx(["orario", "ora", "time"]);
  const iDesc = idx(["descrizione", "alimenti", "description", "menu"]);
  if (iSlot < 0 || iDesc < 0) return { items: [], errors: ["Intestazione richiesta: giorno;pasto;orario;descrizione"] };
  const items: MealItem[] = [];
  const errors: string[] = [];
  lines.forEach((line, n) => {
    const c = line.split(sep).map((x) => x.trim().replace(/^"|"$/g, ""));
    const slot = slotMap[(c[iSlot] ?? "").toLowerCase()];
    const dayRaw = iDay >= 0 ? (c[iDay] ?? "").toLowerCase().slice(0, 3) : "";
    const weekday = !dayRaw || dayRaw === "tut" || dayRaw === "all" ? null : (dayMap[dayRaw] ?? -1);
    const time = iTime >= 0 && c[iTime] ? c[iTime].padStart(5, "0") : null;
    const parsed = mealItemSchema.safeParse({ weekday, slot, time_hint: time, description: c[iDesc] });
    if (!slot || weekday === -1 || !parsed.success) errors.push(`Riga ${n + 2}: dati non validi`);
    else items.push(parsed.data);
  });
  return { items, errors };
}

/** Pasti del giorno dal piano attivo (se assente: nessun pasto inventato, solo orari standard nel planner). */
export function mealsForDay(items: MealItem[], isoWeekday: number) {
  const order = { breakfast: 1, lunch: 2, snack: 3, dinner: 4 } as const;
  return items.filter((i) => i.weekday == null || i.weekday === isoWeekday).sort((a, b) => order[a.slot] - order[b.slot]);
}

// ---------------------------------------------------------------------------
// Conversione righe DB -> impegni fissi per lo scheduler
// ---------------------------------------------------------------------------
export function eventToFixed(e: {
  id: string;
  title: string;
  area: FixedItem["area"];
  starts_at: string;
  ends_at: string;
  travel_before_minutes: number;
  travel_after_minutes: number;
  involves_others: boolean;
  is_external: boolean;
}): FixedItem {
  return {
    id: e.id,
    title: e.title,
    area: e.area,
    start: new Date(e.starts_at),
    end: new Date(e.ends_at),
    travelBefore: e.travel_before_minutes,
    travelAfter: e.travel_after_minutes,
    kind: "event",
    involvesOthers: e.involves_others,
    external: e.is_external,
  };
}

export function isoWeekday(date: string, tz: string): number {
  return zonedParts(zonedToUtc(date, "12:00", tz), tz).weekday;
}
