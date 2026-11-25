/**
 * Report intelligenti: calcoli SOLO su dati registrati. Valori mancanti = null ("dati
 * insufficienti"), mai stime inventate. I suggerimenti non incentivano il sovraccarico:
 * se il lavoro supera la soglia, l'indicazione e' ridurre, non intensificare.
 */
import type { LifeArea } from "./domain";
import { AREA_LABEL } from "./domain";

export type TimeEntry = { area: LifeArea; client_id: string | null; minutes: number; started_at: string };
export type Block = { area: LifeArea; kind: string; status: string; startMin?: number; minutes: number; actual_minutes: number | null };
export type TaskRow = { status: string; completed_at: string | null; postponed_count: number; area: LifeArea; client_id: string | null };

export type WeeklyInput = {
  periodStart: string;
  periodEnd: string;
  entries: TimeEntry[];
  blocks: Block[];
  tasks: TaskRow[];
  clients: { id: string; name: string; weekly_target_minutes: number | null; active: boolean }[];
  sleepAvgMinutes: number | null;
  sleepGoalMinutes: number;
  workoutsDone: number;
  workoutsPlanned: number;
  studyMinutes: number;
  habitCompletion: number | null; // 0-1
  maxWorkMinutesPerDay: number;
  days: number;
};

export type WeeklyReport = {
  period: { start: string; end: string };
  minutesByArea: Record<string, number>;
  minutesByClient: { clientId: string; name: string; minutes: number; target: number | null }[];
  neglectedClients: { name: string; minutes: number; target: number | null }[];
  plannedVsActual: { area: string; planned: number; actual: number | null }[];
  tasks: { completed: number; postponed: number; open: number };
  workMinutes: number;
  avgWorkPerDay: number;
  freeTimeNote: string | null;
  sleepAvgMinutes: number | null;
  workouts: { done: number; planned: number };
  studyMinutes: number;
  habitCompletion: number | null;
  suggestions: string[];
};

const WORK: LifeArea[] = ["marketing", "trading", "ironedge"];

export function weeklyReport(i: WeeklyInput): WeeklyReport {
  const byArea: Record<string, number> = {};
  for (const e of i.entries) byArea[e.area] = (byArea[e.area] ?? 0) + e.minutes;
  const byClient = new Map<string, number>();
  for (const e of i.entries) if (e.client_id) byClient.set(e.client_id, (byClient.get(e.client_id) ?? 0) + e.minutes);
  const minutesByClient = i.clients
    .filter((c) => c.active)
    .map((c) => ({ clientId: c.id, name: c.name, minutes: byClient.get(c.id) ?? 0, target: c.weekly_target_minutes }));
  const neglected = minutesByClient
    .filter((c) => (c.target ? c.minutes < c.target * 0.5 : c.minutes === 0))
    .map((c) => ({ name: c.name, minutes: c.minutes, target: c.target }));
  const planned: Record<string, { p: number; a: number; hasActual: boolean }> = {};
  for (const b of i.blocks) {
    if (["sleep", "wind_down", "buffer", "travel"].includes(b.kind)) continue;
    const k = b.area;
    planned[k] ??= { p: 0, a: 0, hasActual: false };
    planned[k].p += b.minutes;
    if (b.actual_minutes != null) {
      planned[k].a += b.actual_minutes;
      planned[k].hasActual = true;
    }
  }
  const workMinutes = WORK.reduce((a, k) => a + (byArea[k] ?? 0), 0);
  const avgWorkPerDay = i.days ? Math.round(workMinutes / i.days) : 0;
  const completed = i.tasks.filter((t) => t.status === "done").length;
  const postponed = i.tasks.filter((t) => t.postponed_count > 0).length;
  const open = i.tasks.filter((t) => t.status === "todo" || t.status === "in_progress").length;

  const s: string[] = [];
  if (avgWorkPerDay > i.maxWorkMinutesPerDay) {
    s.push(`Lavoro medio di ${(avgWorkPerDay / 60).toFixed(1)} h/giorno, oltre il limite che hai impostato: riduci o delega, non comprimere sonno e pause.`);
  }
  if (i.sleepAvgMinutes != null && i.sleepAvgMinutes < i.sleepGoalMinutes - 30) {
    s.push("Sonno medio sotto l'obiettivo: la prossima settimana proteggi l'orario di riposo prima di aggiungere attivita'.");
  }
  for (const c of neglected.slice(0, 3)) {
    s.push(c.target ? `${c.name}: ${Math.round(c.minutes / 60)} h su ${Math.round(c.target / 60)} h previste. Valuta un blocco dedicato.` : `${c.name}: nessun tempo registrato questa settimana.`);
  }
  if (i.workoutsPlanned > 0 && i.workoutsDone < i.workoutsPlanned) {
    s.push(`Allenamenti: ${i.workoutsDone}/${i.workoutsPlanned}. Meglio meno sedute costanti che recuperi concentrati.`);
  }
  if (postponed >= 3) s.push(`${postponed} task rimandate piu' volte: riducine la stima o spezzale in passi da 30-60 minuti.`);
  if (!i.entries.length) s.push("Nessun tempo effettivo registrato: senza dati il confronto pianificato/effettivo non e' disponibile.");

  return {
    period: { start: i.periodStart, end: i.periodEnd },
    minutesByArea: byArea,
    minutesByClient,
    neglectedClients: neglected,
    plannedVsActual: Object.entries(planned).map(([area, v]) => ({ area: AREA_LABEL[area as LifeArea] ?? area, planned: v.p, actual: v.hasActual ? v.a : null })),
    tasks: { completed, postponed, open },
    workMinutes,
    avgWorkPerDay,
    freeTimeNote: null,
    sleepAvgMinutes: i.sleepAvgMinutes,
    workouts: { done: i.workoutsDone, planned: i.workoutsPlanned },
    studyMinutes: i.studyMinutes,
    habitCompletion: i.habitCompletion,
    suggestions: s,
  };
}

/** Distribuzione del tempo lavorativo tra clienti: priorita' + scadenze, senza superare la capacita'. */
export function allocateClientTime(
  clients: { id: string; name: string; priority: number; weeklyTarget: number | null; spent: number; nearestDueDays: number | null }[],
  availableMinutes: number,
): { id: string; name: string; minutes: number; reason: string }[] {
  const needs = clients.map((c) => {
    const remaining = Math.max(0, (c.weeklyTarget ?? 0) - c.spent);
    const urgency = c.nearestDueDays == null ? 0 : c.nearestDueDays <= 1 ? 3 : c.nearestDueDays <= 3 ? 2 : c.nearestDueDays <= 7 ? 1 : 0;
    return { ...c, remaining, weight: (5 - c.priority) + urgency * 2 };
  });
  const totalWeight = needs.reduce((a, n) => a + (n.remaining > 0 || n.nearestDueDays != null ? n.weight : 0), 0) || 1;
  let left = availableMinutes;
  return needs
    .sort((a, b) => b.weight - a.weight)
    .map((n) => {
      const share = Math.round((availableMinutes * n.weight) / totalWeight / 15) * 15;
      const minutes = Math.max(0, Math.min(left, n.remaining || share, share));
      left -= minutes;
      const reason = n.nearestDueDays != null && n.nearestDueDays <= 3 ? `scadenza tra ${n.nearestDueDays} g` : n.remaining > 0 ? `mancano ${Math.round(n.remaining / 60)} h all'obiettivo settimanale` : "mantenimento";
      return { id: n.id, name: n.name, minutes, reason };
    })
    .filter((x) => x.minutes > 0);
}
