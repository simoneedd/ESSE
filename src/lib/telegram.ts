import { redact } from "./security";

/** Client Telegram minimale (riusato dal pattern IronEdge). Bot DEDICATO a Personal OS. */
const API = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function sendTelegramMessage(token: string, chatId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<{ message_id: number }> {
  if (!/^-?\d+$/.test(chatId)) throw new TelegramError("Chat non valida", false);
  if (!text.trim() || text.length > 4096) throw new TelegramError("Testo non valido", false);
  const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // testo semplice: nessun parse_mode, nessuna iniezione di markup
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id: number }; description?: string } | null;
  if (!res.ok || !body?.ok || !body.result) {
    throw new TelegramError(redact(body?.description ?? `HTTP ${res.status}`), res.status === 429 || res.status >= 500);
  }
  return { message_id: body.result.message_id };
}
