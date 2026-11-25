/**
 * Smart Scheduler — motore deterministico di pianificazione giornaliera.
 *
 * Principi vincolanti:
 *  1. Il sonno e' un vincolo prioritario: la finestra della giornata va dalla sveglia all'inizio
 *     della routine serale; il motore NON accorcia mai il sonno per far stare il lavoro.
 *     Con sonno insufficiente la capacita' lavorativa viene RIDOTTA, non aumentata.
 *  2. Gli impegni fissi (eventi, riunioni, sessioni con orario pubblico) non vengono mai spostati:
 *     sovrapposizioni -> segnalazione + proposta che richiede approvazione.
 *  3. Le attivita' flessibili si collocano negli spazi liberi rispettando dipendenze, priorita',
 *     scadenze, orario di lavoro, pause e un margine per imprevisti (buffer).
 *  4. Se la domanda supera la capacita' il motore NON comprime: segnala il sovraccarico e propone
 *     cosa rimandare.
 * Tutti i tempi interni sono "minuti dalla mezzanotte locale" del giorno pianificato
 * (possono superare 1440 per orari dopo mezzanotte).
 */
import type { LifeArea } from "../domain";
import { addDays, hhmmToMinutes, minutesToHhmm, zonedParts, zonedToUtc, localDate } from "../time";

export type FixedItem = {
  id: string;
  title: string;
  area: LifeArea;
  start: Date;
  end: Date;
  travelBefore?: number;
  travelAfter?: number;
  kind: "event" | "trading" | "workout" | "study";
  involvesOthers?: boolean;
  external?: boolean;
};

export type FlexibleTask = {
  id: string;
  title: string;
  area: LifeArea;
  priority: 1 | 2 | 3 | 4;
  estimatedMinutes: number | null;
  dueAt: Date | null;
  dependsOn: string[];
  done: boolean;
  clientId?: string | null;
  /** l'utente ha autorizzato la riprogrammazione autonoma per questa attivita' */
  autoReschedule: boolean;
  kind?: "task" | "workout" | "study" | "trading";
};

export type MealSlot = { slot: "breakfast" | "lunch" | "dinner" | "snack"; time: string; minutes: number; title?: string };

export type Settings = {
  timezone: string;
  targetWake: string; // HH:MM
  targetBedtime: string; // HH:MM (puo' essere dopo mezzanotte, es. 00:30)
  sleepGoalMinutes: number;
  workdayStart: string;
  workdayEnd: string;
  maxWorkMinutes: number;
  bufferPercent: number;
  windDownMinutes?: number;
  focusBlockMinutes?: number; // dopo questo tempo continuo si inserisce una pausa
  breakMinutes?: number;
};

export type PlanInput = {
  date: string; // YYYY-MM-DD locale
  settings: Settings;
  fixed: FixedItem[];
  tasks: FlexibleTask[];
  meals?: MealSlot[];
  /** minuti dormiti la notte precedente (se noti) */
  lastNightSleepMinutes?: number | null;
  /** sveglia effettiva di oggi, se diversa dall'obiettivo (HH:MM) */
  actualWake?: string | null;
  now?: Date;
};

export type PlannedBlock = {
  start: Date;
  end: Date;
  startMin: number;
  endMin: number;
  title: string;
  area: LifeArea;
  kind: "task" | "event" | "meal" | "workout" | "study" | "trading" | "break" | "buffer" | "travel" | "sleep" | "wind_down";
  flexibility: "fixed" | "flexible";
  refId?: string;
  part?: { index: number; of: number };
};

export type Conflict = { a: string; b: string; overlapMinutes: number; message: string };
export type Unscheduled = { taskId: string; title: string; minutes: number; reason: string; autoReschedule: boolean };

export type PlanResult = {
  date: string;
  dayStartMin: number;
  dayEndMin: number;
  blocks: PlannedBlock[];
  conflicts: Conflict[];
  unscheduled: Unscheduled[];
  warnings: string[];
  stats: {
    workCapacityMinutes: number;
    workPlannedMinutes: number;
    flexibleDemandMinutes: number;
    freeMinutes: number;
    bufferMinutes: number;
    sleepDeficitMinutes: number;
  };
  overloaded: boolean;
};

const WORK_AREAS: LifeArea[] = ["marketing", "trading", "ironedge"];
export const isWorkArea = (a: LifeArea) => WORK_AREAS.includes(a);
const DEFAULT_TASK_MIN = 30;
const MIN_CHUNK = 25;

type Interval = { s: number; e: number };

function minutesOf(date: Date, day: string, tz: string): number {
  const d = localDate(date, tz);
  const p = zonedParts(date, tz);
  const base = p.hour * 60 + p.minute;
  if (d === day) return base;
  // giorno successivo o precedente
  return d > day ? base + 1440 : base - 1440;
}

export function toInstant(day: string, minutes: number, tz: string): Date {
  const dayOffset = Math.floor(minutes / 1440);
  return zonedToUtc(addDays(day, dayOffset), minutesToHhmm(minutes - dayOffset * 1440), tz);
}

function subtract(free: Interval[], busy: Interval): Interval[] {
  const out: Interval[] = [];
  for (const f of free) {
    if (busy.e <= f.s || busy.s >= f.e) {
      out.push(f);
      continue;
    }
    if (busy.s > f.s) out.push({ s: f.s, e: busy.s });
    if (busy.e < f.e) out.push({ s: busy.e, e: f.e });
  }
  return out;
}

const total = (iv: Interval[]) => iv.reduce((a, i) => a + (i.e - i.s), 0);

/** Ordinamento topologico stabile: una task viene dopo le sue dipendenze aperte. */
export function orderByDependencies<T extends { id: string; dependsOn: string[] }>(items: T[], score: (t: T) => number): { ordered: T[]; blocked: T[] } {
  const byId = new Map(items.map((t) => [t.id, t]));
  const sorted = [...items].sort((a, b) => score(a) - score(b));
  const ordered: T[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const blocked: T[] = [];
  const visit = (t: T): boolean => {
    if (placed.has(t.id)) return true;
    if (visiting.has(t.id)) return false; // ciclo
    visiting.add(t.id);
    for (const dep of t.dependsOn) {
      const d = byId.get(dep);
      if (d && !visit(d)) {
        visiting.delete(t.id);
        return false;
      }
    }
    visiting.delete(t.id);
    placed.add(t.id);
    ordered.push(t);
    return true;
  };
  for (const t of sorted) if (!visit(t)) blocked.push(t);
  return { ordered, blocked };
}

export function sleepAdjustedCapacity(maxWork: number, sleepGoal: number, slept: number | null | undefined): { capacity: number; deficit: number } {
  if (slept == null) return { capacity: maxWork, deficit: 0 };
  const deficit = Math.max(0, sleepGoal - slept);
  // ogni ora di sonno mancante riduce del 10% la capacita' lavorativa (max -40%): niente compensazioni col lavoro extra
  const reduction = Math.min(0.4, (deficit / 60) * 0.1);
  return { capacity: Math.round(maxWork * (1 - reduction)), deficit };
}

export function planDay(input: PlanInput): PlanResult {
  const { date, settings: s } = input;
  const tz = s.timezone;
  const windDown = s.windDownMinutes ?? 30;
  const focus = s.focusBlockMinutes ?? 90;
  const breakMin = s.breakMinutes ?? 15;
  const warnings: string[] = [];

  const wake = hhmmToMinutes(input.actualWake ?? s.targetWake);
  let bed = hhmmToMinutes(s.targetBedtime);
  if (bed <= wake) bed += 1440; // coricarsi dopo mezzanotte
  // il sonno e' protetto: se l'obiettivo di sonno non entra tra coricarsi e sveglia di domani, si anticipa il coricarsi
  const nextWake = hhmmToMinutes(s.targetWake) + 1440;
  if (nextWake - bed < s.sleepGoalMinutes) {
    bed = nextWake - s.sleepGoalMinutes;
    warnings.push(`Orario di riposo anticipato alle ${minutesToHhmm(bed)} per garantire ${Math.round(s.sleepGoalMinutes / 60 * 10) / 10} h di sonno.`);
  }
  const { capacity, deficit } = sleepAdjustedCapacity(s.maxWorkMinutes, s.sleepGoalMinutes, input.lastNightSleepMinutes);
  if (deficit >= 30) {
    warnings.push(
      `Hai dormito circa ${Math.round(deficit)} min meno dell'obiettivo: capacita' lavorativa ridotta a ${Math.round(capacity / 6) / 10} h. Il recupero non si fa allungando la giornata.`,
    );
  }
  const dayStart = wake;
  const dayEnd = bed - windDown;
  const blocks: PlannedBlock[] = [];
  const conflicts: Conflict[] = [];
  let free: Interval[] = [{ s: dayStart, e: dayEnd }];

  const push = (b: Omit<PlannedBlock, "start" | "end">) => {
    blocks.push({ ...b, start: toInstant(date, b.startMin, tz), end: toInstant(date, b.endMin, tz) });
  };

  // 1) impegni fissi (+ spostamenti)
  const fixed = input.fixed
    .map((f) => ({ ...f, s: minutesOf(f.start, date, tz), e: minutesOf(f.end, date, tz) }))
    .filter((f) => f.e > f.s && f.e > dayStart - 1440 && f.s < dayEnd + 1440)
    .sort((a, b) => a.s - b.s);
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      const a = fixed[i];
      const b = fixed[j];
      const aS = a.s - (a.travelBefore ?? 0);
      const aE = a.e + (a.travelAfter ?? 0);
      const bS = b.s - (b.travelBefore ?? 0);
      const bE = b.e + (b.travelAfter ?? 0);
      const ov = Math.min(aE, bE) - Math.max(aS, bS);
      if (ov > 0) {
        conflicts.push({
          a: a.id,
          b: b.id,
          overlapMinutes: ov,
          message: `"${a.title}" e "${b.title}" si sovrappongono di ${ov} min${(a.travelAfter || b.travelBefore) ? " (spostamenti inclusi)" : ""}. Serve una tua decisione.`,
        });
      }
    }
  }
  for (const f of fixed) {
    if (f.s < dayStart || f.e > dayEnd) {
      if (f.s < dayEnd && f.e > dayStart) {
        warnings.push(`"${f.title}" cade fuori dalla finestra di veglia pianificata (sveglia ${minutesToHhmm(dayStart)}, riposo ${minutesToHhmm(dayEnd + windDown)}).`);
      }
    }
    if (f.travelBefore) {
      push({ startMin: f.s - f.travelBefore, endMin: f.s, title: `Spostamento → ${f.title}`, area: f.area, kind: "travel", flexibility: "fixed", refId: f.id });
      free = subtract(free, { s: f.s - f.travelBefore, e: f.s });
    }
    push({ startMin: f.s, endMin: f.e, title: f.title, area: f.area, kind: f.kind === "event" ? "event" : f.kind, flexibility: "fixed", refId: f.id });
    free = subtract(free, { s: f.s, e: f.e });
    if (f.travelAfter) {
      push({ startMin: f.e, endMin: f.e + f.travelAfter, title: `Rientro da ${f.title}`, area: f.area, kind: "travel", flexibility: "fixed", refId: f.id });
      free = subtract(free, { s: f.e, e: f.e + f.travelAfter });
    }
  }
  const fixedWorkMinutes = fixed.filter((f) => isWorkArea(f.area)).reduce((a, f) => a + Math.max(0, Math.min(f.e, dayEnd) - Math.max(f.s, dayStart)), 0);

  // 2) pasti: semi-fissi, si spostano fino a +-60 min per evitare impegni fissi
  const meals = input.meals ?? [
    { slot: "breakfast", time: minutesToHhmm(dayStart + 15), minutes: 20 },
    { slot: "lunch", time: "13:00", minutes: 45 },
    { slot: "dinner", time: "20:00", minutes: 45 },
  ];
  const mealTitle: Record<string, string> = { breakfast: "Colazione", lunch: "Pranzo", dinner: "Cena", snack: "Spuntino" };
  for (const m of meals) {
    let target = hhmmToMinutes(m.time);
    if (target < dayStart) target = Math.max(target, dayStart);
    let placed: Interval | null = null;
    for (const delta of [0, 15, -15, 30, -30, 45, -45, 60, -60]) {
      const st = target + delta;
      const slot = { s: st, e: st + m.minutes };
      if (slot.s >= dayStart && slot.e <= dayEnd && free.some((f) => f.s <= slot.s && f.e >= slot.e)) {
        placed = slot;
        break;
      }
    }
    if (placed) {
      push({ startMin: placed.s, endMin: placed.e, title: m.title ?? mealTitle[m.slot], area: "health", kind: "meal", flexibility: "flexible" });
      free = subtract(free, placed);
    } else {
      warnings.push(`Nessuno spazio per ${mealTitle[m.slot].toLowerCase()} vicino alle ${m.time}: valuta di liberare tempo.`);
    }
  }

  // 3) buffer per imprevisti: riservato sul tempo libero residuo, non assegnabile alle task
  const freeAfterFixed = total(free);
  const bufferMinutes = Math.round((freeAfterFixed * s.bufferPercent) / 100);

  // 4) attivita' flessibili
  const now = input.now ?? new Date();
  const dayEndInstant = toInstant(date, dayEnd, tz);
  const open = input.tasks.filter((t) => !t.done);
  const score = (t: FlexibleTask) => {
    const due = t.dueAt ? t.dueAt.getTime() : Number.POSITIVE_INFINITY;
    const overdue = t.dueAt && t.dueAt < now ? -2 : 0;
    const dueToday = t.dueAt && t.dueAt <= dayEndInstant ? -1 : 0;
    return (overdue + dueToday) * 1e15 + t.priority * 1e13 + (Number.isFinite(due) ? due / 1000 : 1e12);
  };
  const doneIds = new Set(input.tasks.filter((t) => t.done).map((t) => t.id));
  const normalized = open.map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => !doneIds.has(d)) }));
  const { ordered, blocked } = orderByDependencies(normalized, score);
  const unscheduled: Unscheduled[] = blocked.map((t) => ({
    taskId: t.id,
    title: t.title,
    minutes: t.estimatedMinutes ?? DEFAULT_TASK_MIN,
    reason: "Dipendenze circolari o non risolvibili",
    autoReschedule: t.autoReschedule,
  }));
  const flexibleDemand = ordered.reduce((a, t) => a + (t.estimatedMinutes ?? DEFAULT_TASK_MIN), 0);
  let workPlanned = fixedWorkMinutes;
  let assignable = Math.max(0, freeAfterFixed - bufferMinutes);
  const scheduledEnd = new Map<string, number>();
  const wStart = hhmmToMinutes(s.workdayStart);
  const wEnd = hhmmToMinutes(s.workdayEnd);
  let continuous = 0;
  let lastEnd = -1;

  for (const t of ordered) {
    const need = t.estimatedMinutes ?? DEFAULT_TASK_MIN;
    const work = isWorkArea(t.area);
    if (work && workPlanned + need > capacity) {
      unscheduled.push({ taskId: t.id, title: t.title, minutes: need, reason: "Capacita' lavorativa giornaliera raggiunta", autoReschedule: t.autoReschedule });
      continue;
    }
    if (need > assignable) {
      unscheduled.push({ taskId: t.id, title: t.title, minutes: need, reason: "Tempo libero insufficiente (margine per imprevisti preservato)", autoReschedule: t.autoReschedule });
      continue;
    }
    const earliest = Math.max(dayStart, ...t.dependsOn.map((d) => scheduledEnd.get(d) ?? dayStart));
    if (t.dependsOn.some((d) => !scheduledEnd.has(d) && normalized.some((x) => x.id === d))) {
      unscheduled.push({ taskId: t.id, title: t.title, minutes: need, reason: "In attesa di una dipendenza non pianificata oggi", autoReschedule: t.autoReschedule });
      continue;
    }
    // finestre ammesse: lavoro dentro l'orario lavorativo, il resto in tutta la giornata
    const windows = free
      .map((f) => ({ s: Math.max(f.s, earliest, work ? wStart : dayStart), e: Math.min(f.e, work ? wEnd : dayEnd) }))
      .filter((f) => f.e - f.s >= Math.min(need, MIN_CHUNK));
    let remaining = need;
    const parts: (Interval & { brk?: boolean })[] = [];
    let cont = continuous;
    let last = lastEnd;
    for (const w of windows) {
      let cursor = w.s;
      while (remaining > 0) {
        let c = cursor === last ? cont : 0;
        if (c >= focus) {
          // pausa obbligatoria dopo un blocco di concentrazione continuo
          if (w.e - cursor < breakMin + Math.min(remaining, MIN_CHUNK)) break;
          parts.push({ s: cursor, e: cursor + breakMin, brk: true });
          cursor += breakMin;
          c = 0;
        }
        const len = Math.min(remaining, w.e - cursor, focus - c);
        if (len < Math.min(remaining, MIN_CHUNK)) break;
        parts.push({ s: cursor, e: cursor + len });
        cursor += len;
        cont = c + len;
        last = cursor;
        remaining -= len;
      }
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      unscheduled.push({ taskId: t.id, title: t.title, minutes: need, reason: work ? "Nessuno spazio libero nell'orario di lavoro" : "Nessuno spazio libero nella giornata", autoReschedule: t.autoReschedule });
      continue;
    }
    continuous = cont;
    lastEnd = last;
    const real = parts.filter((p) => !p.brk);
    for (const p of parts) {
      if (p.brk) {
        push({ startMin: p.s, endMin: p.e, title: "Pausa", area: "personal", kind: "break", flexibility: "flexible" });
        free = subtract(free, p);
      }
    }
    real.forEach((p, i) => {
      const kind = t.kind === "workout" ? "workout" : t.kind === "study" ? "study" : t.kind === "trading" ? "trading" : "task";
      push({ startMin: p.s, endMin: p.e, title: t.title, area: t.area, kind, flexibility: "flexible", refId: t.id, part: real.length > 1 ? { index: i + 1, of: real.length } : undefined });
      free = subtract(free, p);
    });
    scheduledEnd.set(t.id, Math.max(...real.map((p) => p.e)));
    assignable -= need;
    if (work) workPlanned += need;
  }

  // 5) routine serale e sonno (sempre presenti)
  push({ startMin: dayEnd, endMin: bed, title: "Routine serale (schermi off)", area: "health", kind: "wind_down", flexibility: "fixed" });
  push({ startMin: bed, endMin: nextWake, title: "Sonno", area: "health", kind: "sleep", flexibility: "fixed" });

  blocks.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const overloaded = unscheduled.some((u) => !u.reason.startsWith("Dipendenze") && !u.reason.startsWith("In attesa")) || conflicts.length > 0;
  if (unscheduled.length) {
    warnings.push(`${unscheduled.length} attivita' non pianificate oggi: proposta di spostamento disponibile.`);
  }
  if (workPlanned > capacity) warnings.push("Gli impegni fissi di lavoro superano la capacita' giornaliera.");

  return {
    date,
    dayStartMin: dayStart,
    dayEndMin: dayEnd,
    blocks,
    conflicts,
    unscheduled,
    warnings,
    stats: {
      workCapacityMinutes: capacity,
      workPlannedMinutes: workPlanned,
      flexibleDemandMinutes: flexibleDemand,
      freeMinutes: total(free),
      bufferMinutes,
      sleepDeficitMinutes: deficit,
    },
    overloaded,
  };
}

export type RescheduleDecision = { taskId: string; title: string; action: "auto_move" | "propose"; toDate: string; reason: string };

/**
 * Attivita' non completate: quelle autorizzate vengono spostate automaticamente al giorno
 * successivo, le altre generano una proposta da approvare. Gli impegni fissi non sono mai qui.
 */
export function rescheduleIncomplete(items: { id: string; title: string; autoReschedule: boolean; fixed: boolean }[], fromDate: string): RescheduleDecision[] {
  return items
    .filter((i) => !i.fixed)
    .map((i) => ({
      taskId: i.id,
      title: i.title,
      action: i.autoReschedule ? ("auto_move" as const) : ("propose" as const),
      toDate: addDays(fromDate, 1),
      reason: i.autoReschedule ? "Riprogrammazione autonoma autorizzata" : "Richiede la tua approvazione",
    }));
}

/** Trova N slot liberi (es. "un'ora al giorno per studiare") nei prossimi giorni senza toccare il sonno. */
export function findDailySlots(plans: PlanResult[], minutes: number, preferAfter = 0): { date: string; startMin: number; endMin: number }[] {
  const out: { date: string; startMin: number; endMin: number }[] = [];
  for (const p of plans) {
    const busy = p.blocks.filter((b) => b.kind !== "sleep").map((b) => ({ s: b.startMin, e: b.endMin }));
    let free: Interval[] = [{ s: p.dayStartMin, e: p.dayEndMin }];
    for (const b of busy) free = subtract(free, b);
    const slot = free.find((f) => f.e - Math.max(f.s, preferAfter) >= minutes) ?? free.find((f) => f.e - f.s >= minutes);
    if (slot) {
      const s = slot.e - Math.max(slot.s, preferAfter) >= minutes ? Math.max(slot.s, preferAfter) : slot.s;
      out.push({ date: p.date, startMin: s, endMin: s + minutes });
    }
  }
  return out;
}
