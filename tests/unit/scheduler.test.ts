import { describe, expect, it } from "vitest";
import { findDailySlots, orderByDependencies, planDay, rescheduleIncomplete, sleepAdjustedCapacity, toInstant, type FlexibleTask, type Settings } from "@/lib/scheduler/engine";

const TZ = "Europe/Rome";
const DAY = "2026-11-26";
const settings: Settings = {
  timezone: TZ,
  targetWake: "07:00",
  targetBedtime: "23:00",
  sleepGoalMinutes: 480,
  workdayStart: "09:00",
  workdayEnd: "18:00",
  maxWorkMinutes: 480,
  bufferPercent: 15,
};
const at = (hhmm: string, day = DAY) => toInstant(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), TZ);
const task = (over: Partial<FlexibleTask> & { id: string }): FlexibleTask => ({
  title: over.id,
  area: "marketing",
  priority: 3,
  estimatedMinutes: 60,
  dueAt: null,
  dependsOn: [],
  done: false,
  autoReschedule: false,
  ...over,
});

const overlaps = (blocks: { startMin: number; endMin: number; kind: string }[]) => {
  const xs = blocks.filter((b) => b.kind !== "sleep" && b.kind !== "wind_down").sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < xs.length; i++) if (xs[i].startMin < xs[i - 1].endMin) return true;
  return false;
};

describe("Smart Scheduler", () => {
  it("protegge il sonno: blocchi Sonno e routine serale sempre presenti e nulla dopo il riposo", () => {
    const r = planDay({ date: DAY, settings, fixed: [], tasks: [task({ id: "a", area: "personal", estimatedMinutes: 600 })] });
    const sleep = r.blocks.find((b) => b.kind === "sleep")!;
    expect(sleep.endMin - sleep.startMin).toBeGreaterThanOrEqual(480);
    expect(r.blocks.filter((b) => b.kind === "task").every((b) => b.endMin <= r.dayEndMin)).toBe(true);
  });

  it("anticipa il riposo se l'obiettivo di sonno non entra (non accorcia mai il sonno)", () => {
    const r = planDay({ date: DAY, settings: { ...settings, targetBedtime: "00:30", targetWake: "07:00" }, fixed: [], tasks: [] });
    const sleep = r.blocks.find((b) => b.kind === "sleep")!;
    expect(sleep.endMin - sleep.startMin).toBe(480);
    expect(r.warnings.join(" ")).toMatch(/anticipato/);
  });

  it("con sonno insufficiente riduce la capacita' lavorativa invece di aumentarla", () => {
    expect(sleepAdjustedCapacity(480, 480, 360)).toEqual({ capacity: 384, deficit: 120 });
    expect(sleepAdjustedCapacity(480, 480, null).capacity).toBe(480);
    expect(sleepAdjustedCapacity(480, 480, 0).capacity).toBe(288); // max -40%
    const tasks = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, estimatedMinutes: 60 }));
    const rested = planDay({ date: DAY, settings, fixed: [], tasks, lastNightSleepMinutes: 480 });
    const tired = planDay({ date: DAY, settings, fixed: [], tasks, lastNightSleepMinutes: 360 });
    expect(tired.stats.workPlannedMinutes).toBeLessThan(rested.stats.workPlannedMinutes);
    expect(tired.warnings.join(" ")).toMatch(/capacita' lavorativa ridotta/);
  });

  it("non sposta gli impegni fissi e rileva le sovrapposizioni (spostamenti inclusi)", () => {
    const r = planDay({
      date: DAY,
      settings,
      fixed: [
        { id: "m1", title: "Riunione cliente", area: "marketing", start: at("10:00"), end: at("11:00"), kind: "event", involvesOthers: true },
        { id: "m2", title: "Dentista", area: "personal", start: at("11:15"), end: at("12:00"), kind: "event", travelBefore: 30 },
      ],
      tasks: [],
    });
    const m1 = r.blocks.find((b) => b.refId === "m1" && b.kind === "event")!;
    expect(m1.start.toISOString()).toBe(at("10:00").toISOString());
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].overlapMinutes).toBe(15);
    expect(r.overloaded).toBe(true);
  });

  it("lavoro solo nell'orario lavorativo; nessuna sovrapposizione tra blocchi", () => {
    const r = planDay({
      date: DAY,
      settings,
      fixed: [{ id: "e", title: "Call", area: "marketing", start: at("09:30"), end: at("10:30"), kind: "event" }],
      tasks: [task({ id: "a" }), task({ id: "b", area: "study", estimatedMinutes: 45 }), task({ id: "c", estimatedMinutes: 120 })],
    });
    const work = r.blocks.filter((b) => b.kind === "task" && b.area === "marketing");
    expect(work.every((b) => b.startMin >= 9 * 60 && b.endMin <= 18 * 60)).toBe(true);
    expect(overlaps(r.blocks)).toBe(false);
  });

  it("rispetta le dipendenze e le priorita'/scadenze", () => {
    const r = planDay({
      date: DAY,
      settings,
      fixed: [],
      tasks: [
        task({ id: "pubblica", dependsOn: ["scrivi"], priority: 1 }),
        task({ id: "scrivi", priority: 3 }),
        task({ id: "urgente", priority: 1, dueAt: at("12:00") }),
      ],
    });
    const start = (id: string) => r.blocks.find((b) => b.refId === id)!.startMin;
    expect(start("scrivi")).toBeLessThan(start("pubblica"));
    expect(start("urgente")).toBeLessThan(start("scrivi"));
  });

  it("dipendenze circolari segnalate, non pianificate", () => {
    const { blocked } = orderByDependencies(
      [
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: [] },
      ],
      () => 0,
    );
    expect(blocked.map((b) => b.id).sort()).toEqual(["a", "b"]);
  });

  it("inserisce pause dopo blocchi di concentrazione lunghi e divide task lunghe", () => {
    const r = planDay({ date: DAY, settings: { ...settings, bufferPercent: 0 }, fixed: [], tasks: [task({ id: "lunga", estimatedMinutes: 180 })] });
    const parts = r.blocks.filter((b) => b.refId === "lunga");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.endMin - p.startMin <= 90)).toBe(true);
    expect(r.blocks.some((b) => b.kind === "break")).toBe(true);
  });

  it("sovraccarico: nessuna compressione, task in eccesso elencate con motivo", () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task({ id: `t${i}`, estimatedMinutes: 90 }));
    const r = planDay({ date: DAY, settings, fixed: [], tasks });
    expect(r.overloaded).toBe(true);
    expect(r.unscheduled.length).toBeGreaterThan(0);
    expect(r.stats.workPlannedMinutes).toBeLessThanOrEqual(r.stats.workCapacityMinutes);
    expect(r.stats.bufferMinutes).toBeGreaterThan(0);
  });

  it("pasti presenti e spostati per evitare impegni fissi", () => {
    const r = planDay({
      date: DAY,
      settings,
      fixed: [{ id: "pranzo-lavoro", title: "Workshop", area: "marketing", start: at("12:30"), end: at("13:30"), kind: "event" }],
      tasks: [],
    });
    const lunch = r.blocks.find((b) => b.title === "Pranzo")!;
    expect(lunch.startMin >= 13 * 60 + 30 || lunch.endMin <= 12 * 60 + 30).toBe(true);
  });

  it("gestisce il cambio d'ora legale (29 marzo 2026)", () => {
    const r = planDay({ date: "2026-03-29", settings, fixed: [], tasks: [task({ id: "a", area: "personal" })] });
    const sleep = r.blocks.find((b) => b.kind === "sleep")!;
    expect(sleep.start.toISOString()).toBe("2026-03-29T21:00:00.000Z"); // 23:00 CEST
  });

  it("ripianificazione: autonoma solo se autorizzata, mai per impegni fissi", () => {
    const d = rescheduleIncomplete(
      [
        { id: "a", title: "Studio", autoReschedule: true, fixed: false },
        { id: "b", title: "Report cliente", autoReschedule: false, fixed: false },
        { id: "c", title: "Riunione", autoReschedule: true, fixed: true },
      ],
      DAY,
    );
    expect(d).toEqual([
      expect.objectContaining({ taskId: "a", action: "auto_move", toDate: "2026-11-27" }),
      expect.objectContaining({ taskId: "b", action: "propose" }),
    ]);
  });

  it("trova un'ora al giorno senza intaccare il sonno", () => {
    const plans = ["2026-11-26", "2026-11-27"].map((d) => planDay({ date: d, settings, fixed: [], tasks: [] }));
    const slots = findDailySlots(plans, 60, 18 * 60);
    expect(slots).toHaveLength(2);
    expect(slots.every((s) => s.startMin >= 18 * 60 && s.endMin <= plans[0].dayEndMin)).toBe(true);
  });
});

describe("Smart Scheduler: qualita' della collocazione", () => {
  it("non spezza attivita' brevi e colloca studio/palestra fuori dall'orario di lavoro se possibile", () => {
    const r = planDay({
      date: DAY,
      settings,
      fixed: [],
      tasks: [
        task({ id: "lavoro", area: "marketing", estimatedMinutes: 120, priority: 1 }),
        task({ id: "studio", area: "study", estimatedMinutes: 45, priority: 3 }),
        task({ id: "palestra", area: "gym", estimatedMinutes: 60, priority: 2 }),
      ],
    });
    for (const id of ["studio", "palestra"]) {
      const parts = r.blocks.filter((b) => b.refId === id);
      expect(parts).toHaveLength(1);
      expect(parts[0].startMin >= 18 * 60 || parts[0].endMin <= 9 * 60).toBe(true);
    }
  });
});
