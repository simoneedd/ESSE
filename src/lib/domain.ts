export const LIFE_AREAS = ["personal", "marketing", "trading", "ironedge", "gym", "study", "health"] as const;
export type LifeArea = (typeof LIFE_AREAS)[number];

export const AREA_LABEL: Record<LifeArea, string> = {
  personal: "Personale",
  marketing: "Marketing",
  trading: "Trading",
  ironedge: "IronEdge",
  gym: "Palestra",
  study: "Studio",
  health: "Benessere",
};

/** Calendari Google separati previsti dalla specifica. */
export const CALENDAR_AREAS: LifeArea[] = ["personal", "marketing", "trading", "ironedge", "gym", "study"];

export const PRIORITY_LABEL: Record<number, string> = { 1: "Urgente", 2: "Alta", 3: "Normale", 4: "Bassa" };

export const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "Da fare",
  in_progress: "In corso",
  done: "Completata",
  skipped: "Saltata",
  cancelled: "Annullata",
};

export const TRADING_KIND_LABEL: Record<string, string> = {
  operative_session: "Sessione operativa",
  market_analysis: "Analisi di mercato",
  chart_prep: "Preparazione grafici",
  macro_event: "Appuntamento macro",
  meeting: "Riunione",
  ironedge_activity: "Attivita' IronEdge",
  tiktok_live: "Live TikTok",
  webinar: "Webinar",
  lesson: "Lezione",
};

export const MEAL_LABEL: Record<string, string> = { breakfast: "Colazione", lunch: "Pranzo", dinner: "Cena", snack: "Spuntino" };

export const STUDY_KIND_LABEL: Record<string, string> = { course: "Corso", subject: "Materia", book: "Libro" };

export function isLifeArea(v: unknown): v is LifeArea {
  return typeof v === "string" && (LIFE_AREAS as readonly string[]).includes(v);
}
