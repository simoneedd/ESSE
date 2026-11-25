/**
 * Gestione orari: si salva sempre in UTC, si ragiona e si mostra in Europe/Rome.
 * Basato su Intl (nessuna dipendenza), corretto ai cambi di ora legale (DST).
 */
export const DEFAULT_TZ = "Europe/Rome";

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(date: Date, timeZone = DEFAULT_TZ): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday as string],
  };
}

/** Data locale (YYYY-MM-DD) nel fuso del workspace. */
export function localDate(date: Date = new Date(), timeZone = DEFAULT_TZ): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Offset (ms) del fuso rispetto a UTC in un dato istante. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converte data+ora locali (es. "2026-03-29", "21:00") in istante UTC.
 * Ore inesistenti (salto DST in avanti) vengono spostate in avanti; ore ambigue
 * (ritorno all'ora solare) usano la prima occorrenza.
 */
export function zonedToUtc(dateStr: string, timeStr: string, timeZone = DEFAULT_TZ): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) throw new Error("Data/ora non valida");
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // offset possibili attorno all'istante (prima e dopo un eventuale cambio d'ora)
  const offBefore = offsetMs(new Date(guess - 6 * 3_600_000), timeZone);
  const offAfter = offsetMs(new Date(guess + 6 * 3_600_000), timeZone);
  const matches = [...new Set([offBefore, offAfter])]
    .map((off) => guess - off)
    .filter((t) => {
      const p = zonedParts(new Date(t), timeZone);
      return p.year === y && p.month === m && p.day === d && p.hour === hh && p.minute === mm;
    })
    .sort((a, b) => a - b);
  // ora ambigua: prima occorrenza; ora inesistente (salto in avanti): si sposta in avanti
  return new Date(matches.length ? matches[0] : guess - offBefore);
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Lunedi' della settimana ISO che contiene la data. */
export function weekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(dateStr, 1 - dow);
}

export function formatLocal(iso: string | Date | null | undefined, timeZone = DEFAULT_TZ, withTime = true): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("it-IT", {
    timeZone,
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  }).format(date);
}

export function formatDateOnly(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("it-IT", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Istante ISO di N ore fa (usato per filtri di finestra temporale lato server). */
export function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** "HH:MM" -> minuti dalla mezzanotte. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function minutesToHhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function formatTime(iso: string | Date, timeZone = DEFAULT_TZ): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("it-IT", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const m = Math.round(minutes);
  const h = Math.floor(Math.abs(m) / 60);
  const r = Math.abs(m) % 60;
  const s = m < 0 ? "-" : "";
  return h ? `${s}${h} h${r ? ` ${r} min` : ""}` : `${s}${r} min`;
}

/** Inizio e fine (UTC) del giorno locale. */
export function dayBoundsUtc(dateStr: string, timeZone = DEFAULT_TZ): { start: Date; end: Date } {
  return { start: zonedToUtc(dateStr, "00:00", timeZone), end: zonedToUtc(addDays(dateStr, 1), "00:00", timeZone) };
}
