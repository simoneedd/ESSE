/**
 * Riconoscimento deterministico dei comandi in italiano (funziona senza AI e senza costi).
 * Ogni intento ha parametri validati con Zod: lo stesso schema e' usato dagli strumenti
 * offerti al modello AI, quindi l'AI puo' solo scegliere tra azioni sicure predefinite.
 */
import { z } from "zod";

export const intentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("plan_day"), day: z.enum(["today", "tomorrow"]) }),
  z.object({ intent: z.literal("log_sleep"), minutes: z.number().int().min(60).max(960), replan: z.boolean() }),
  z.object({ intent: z.literal("allocate_client"), day: z.enum(["today", "tomorrow"]), minutes: z.number().int().min(15).max(720), client: z.string().max(120).nullable() }),
  z.object({ intent: z.literal("replan_around"), day: z.enum(["today", "tomorrow"]), start: z.string().regex(/^\d{2}:\d{2}$/).nullable(), end: z.string().regex(/^\d{2}:\d{2}$/).nullable() }),
  z.object({ intent: z.literal("plan_workouts"), count: z.number().int().min(1).max(7) }),
  z.object({ intent: z.literal("find_study_slots"), minutes: z.number().int().min(15).max(240), days: z.number().int().min(1).max(14) }),
  z.object({ intent: z.literal("neglected_clients") }),
  z.object({ intent: z.literal("ironedge_open") }),
  z.object({ intent: z.literal("time_spent"), area: z.enum(["personal", "marketing", "trading", "ironedge", "gym", "study", "health"]), period: z.enum(["week", "month"]) }),
  z.object({ intent: z.literal("remember"), kind: z.enum(["preference", "decision", "fact", "constraint"]), content: z.string().min(3).max(1000) }),
  z.object({ intent: z.literal("help") }),
]);
export type Intent = z.infer<typeof intentSchema>;

const NUM: Record<string, number> = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12,
};

/** "sei ore e mezza", "6h30", "6,5 ore", "tre ore", "un'ora", "90 minuti" -> minuti. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase().replace(/un'ora/g, "1 ora");
  let m = /(\d{1,2})\s*h\s*(\d{1,2})/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /(\d{1,2})[.,](\d)\s*or[ae]/.exec(t);
  if (m) return Math.round(Number(`${m[1]}.${m[2]}`) * 60);
  m = new RegExp(`(\\d{1,2}|${Object.keys(NUM).join("|")})\\s*(?:or[ae]|h\\b)(\\s*e\\s*mezz[ao])?(?:\\s*e\\s*(\\d{1,2})\\s*min)?`).exec(t);
  if (m) {
    const h = /\d/.test(m[1]) ? Number(m[1]) : NUM[m[1]];
    return h * 60 + (m[2] ? 30 : 0) + (m[3] ? Number(m[3]) : 0);
  }
  m = /(\d{2,3})\s*min/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

function parseCount(text: string): number | null {
  const m = new RegExp(`\\b(\\d|${Object.keys(NUM).join("|")})\\b`).exec(text.toLowerCase());
  if (!m) return null;
  return /\d/.test(m[1]) ? Number(m[1]) : NUM[m[1]];
}

function timeRange(text: string): { start: string | null; end: string | null } {
  const m = /dalle\s*(\d{1,2})(?:[:.](\d{2}))?\s*alle\s*(\d{1,2})(?:[:.](\d{2}))?/.exec(text);
  if (!m) return { start: null, end: null };
  const f = (h: string, mm?: string) => `${h.padStart(2, "0")}:${mm ?? "00"}`;
  return { start: f(m[1], m[2]), end: f(m[3], m[4]) };
}

const day = (t: string): "today" | "tomorrow" => (/domani/.test(t) ? "tomorrow" : "today");

export function parseIntent(input: string): Intent | null {
  const t = input.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (/^(ricorda|ricordati|memorizza)\b/.test(t)) {
    const content = input.replace(/^\s*(ricorda(ti)?|memorizza)\s*(che)?\s*/i, "").trim();
    const kind = /preferisco|mi piace|non voglio|evita/.test(t) ? "preference" : /ho deciso|decisione/.test(t) ? "decision" : /mai|sempre|non posso/.test(t) ? "constraint" : "fact";
    return content.length >= 3 ? { intent: "remember", kind, content: content.slice(0, 1000) } : null;
  }
  if (/(ho dormito|dormito solo|stanotte ho dormito)/.test(t)) {
    const minutes = parseDuration(t);
    if (minutes) return { intent: "log_sleep", minutes, replan: true };
  }
  if (/client/.test(t) && /(trascur|ignor|non segu|indietro)/.test(t)) return { intent: "neglected_clients" };
  if (/ironedge/.test(t) && /(incomplet|aperte|da fare|ancora|mancan|non complet)/.test(t)) return { intent: "ironedge_open" };
  if (/quanto tempo|quante ore/.test(t)) {
    const area =
      /marketing|client/.test(t) ? "marketing" : /trading/.test(t) ? "trading" : /ironedge/.test(t) ? "ironedge" : /studi/.test(t) ? "study" : /palestra|allenament/.test(t) ? "gym" : "personal";
    return { intent: "time_spent", area, period: /mese/.test(t) ? "month" : "week" };
  }
  if (/allenament/.test(t) && /(inserisci|aggiungi|pianifica|programma|metti)/.test(t)) {
    const count = parseCount(t.replace(/allenament\w*/, ""));
    if (count) return { intent: "plan_workouts", count: Math.min(7, count) };
  }
  if (/(trova|trovami|cerca)/.test(t) && /studi/.test(t)) {
    return { intent: "find_study_slots", minutes: parseDuration(t) ?? 60, days: /settiman/.test(t) ? 7 : /al giorno|ogni giorno/.test(t) ? 7 : 1 };
  }
  if (/dedicare|dedica|lavorare/.test(t) && /client/.test(t)) {
    const minutes = parseDuration(t);
    const cm = /client[ea]?\s+([A-Za-zÀ-ÿ0-9][\wÀ-ÿ&.' -]{1,60})$/.exec(input.trim());
    const client = cm && !/^(che|per|a|al)\b/i.test(cm[1]) ? cm[1].trim() : null;
    if (minutes) return { intent: "allocate_client", day: day(t), minutes, client };
  }
  if (/sposta|riorganizz|ripianific|libera/.test(t) && /(appuntamento|impegno|riunione|flessibil)/.test(t)) {
    return { intent: "replan_around", day: day(t), ...timeRange(t) };
  }
  if (/(organizz|pianific|programma|prepara).*(giornata|agenda|domani|oggi)/.test(t)) return { intent: "plan_day", day: day(t) };
  if (/^(aiuto|help|cosa sai fare|comandi)/.test(t)) return { intent: "help" };
  return null;
}

export const HELP_TEXT = [
  "Posso aiutarti con comandi come:",
  "• Organizzami la giornata di domani",
  "• Oggi ho dormito sei ore, riorganizza le mie attivita'",
  "• Domani devo dedicare tre ore al cliente Rossi",
  "• Sposta le attivita' flessibili perche' ho un appuntamento dalle 15 alle 16",
  "• Inserisci quattro allenamenti questa settimana",
  "• Trovami un'ora al giorno per studiare",
  "• Quali clienti sto trascurando?",
  "• Quali task IronEdge sono ancora incomplete?",
  "• Quanto tempo ho dedicato al marketing questa settimana?",
  "• Ricorda che preferisco allenarmi la mattina",
].join("\n");
