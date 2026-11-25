import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Protocollo server-to-server Personal OS <-> IronEdge Growth OS (v1).
 *
 * File IDENTICO nei due repository (IronEdge: src/lib/personal-os-protocol.ts).
 *
 * Sicurezza:
 *  - firma HMAC-SHA256 con segreto condiviso (>= 32 caratteri) conservato SOLO lato server
 *    (env PERSONAL_OS_SHARED_SECRET in IronEdge, IRONEDGE_SHARED_SECRET in Personal OS);
 *  - la firma copre metodo, path, timestamp, nonce e hash del corpo: nessuna manomissione;
 *  - finestra temporale +-300 s e nonce monouso (replay protection lato IronEdge);
 *  - permessi minimi: l'API espone solo lettura delle task di UN workspace e il cambio di stato
 *    di un'occorrenza (open/done). Nessun'altra tabella e' raggiungibile.
 *  - minimizzazione: Personal OS invia SOLO {external_id, status, base_version}; i dati personali,
 *    alimentari e sanitari non hanno alcun campo nel contratto e vengono rifiutati (schema strict).
 */

export const PROTOCOL_VERSION = "pos-v1";
export const MAX_SKEW_SECONDS = 300;
export const MAX_BODY_BYTES = 16_384;

export const HEADER = {
  version: "x-pos-version",
  timestamp: "x-pos-timestamp",
  nonce: "x-pos-nonce",
  signature: "x-pos-signature",
  idempotency: "idempotency-key",
} as const;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function canonicalString(method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return [PROTOCOL_VERSION, method.toUpperCase(), path, timestamp, nonce, sha256Hex(body)].join("\n");
}

export function sign(secret: string, method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return createHmac("sha256", secret).update(canonicalString(method, path, timestamp, nonce, body)).digest("hex");
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Header firmati per una richiesta in uscita. `path` include la query string. */
export function signedHeaders(secret: string, method: string, path: string, body = "", now = Date.now(), nonce = newNonce()): Record<string, string> {
  if (!secret || secret.length < 32) throw new Error("Segreto di integrazione assente o troppo corto");
  const ts = String(Math.floor(now / 1000));
  return {
    [HEADER.version]: PROTOCOL_VERSION,
    [HEADER.timestamp]: ts,
    [HEADER.nonce]: nonce,
    [HEADER.signature]: sign(secret, method, path, ts, nonce, body),
  };
}

export type VerifyResult = { ok: true; nonce: string; timestamp: number } | { ok: false; status: 400 | 401; reason: string };

/** Verifica a tempo costante. Il controllo del nonce (replay) va fatto poi su database. */
export function verifySignedRequest(
  secret: string | undefined,
  req: { method: string; path: string; headers: Headers; body: string },
  now = Date.now(),
): VerifyResult {
  if (!secret || secret.length < 32) return { ok: false, status: 401, reason: "integrazione non configurata" };
  if (req.headers.get(HEADER.version) !== PROTOCOL_VERSION) return { ok: false, status: 400, reason: "versione protocollo" };
  const ts = req.headers.get(HEADER.timestamp) ?? "";
  const nonce = req.headers.get(HEADER.nonce) ?? "";
  const sig = req.headers.get(HEADER.signature) ?? "";
  if (!/^\d{9,11}$/.test(ts) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) {
    return { ok: false, status: 401, reason: "header firma non validi" };
  }
  const t = Number(ts);
  if (Math.abs(now / 1000 - t) > MAX_SKEW_SECONDS) return { ok: false, status: 401, reason: "timestamp fuori finestra" };
  if (Buffer.byteLength(req.body, "utf8") > MAX_BODY_BYTES) return { ok: false, status: 400, reason: "corpo troppo grande" };
  const expected = Buffer.from(sign(secret, req.method, req.path, ts, nonce, req.body), "hex");
  const given = Buffer.from(sig, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 401, reason: "firma non valida" };
  return { ok: true, nonce, timestamp: t };
}

// ---------------------------------------------------------------------------
// Contratto dati
// ---------------------------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Una occorrenza di task IronEdge come esposta a Personal OS. */
export const remoteTaskSchema = z.object({
  occurrence_id: z.uuid(),
  task_id: z.uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).nullable(),
  priority: z.number().int().min(1).max(4).nullable(),
  due_date: isoDate.nullable(),
  occurrence_date: isoDate,
  estimated_minutes: z.number().int().min(5).max(1440).nullable(),
  status: z.enum(["open", "done", "skipped"]),
  category: z.string().max(80).nullable(),
  depends_on: z.array(z.uuid()).max(50),
  completed_at: z.string().nullable(),
  version: z.string().min(1).max(64), // updated_at dell'occorrenza (ISO)
  task_active: z.boolean(),
  url: z.string().max(500),
});
export type RemoteTask = z.infer<typeof remoteTaskSchema>;

export const listResponseSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  items: z.array(remoteTaskSchema).max(500),
  next_cursor: z.string().max(64).nullable(),
  has_more: z.boolean(),
  server_time: z.string(),
});
export type ListResponse = z.infer<typeof listResponseSchema>;

/** Unica scrittura consentita: cambio di stato. strict(): qualsiasi campo extra viene rifiutato. */
export const statusUpdateSchema = z
  .object({
    external_id: z.string().regex(/^occ:[0-9a-f-]{36}$/),
    status: z.enum(["open", "done"]),
    base_version: z.string().max(64).nullable(),
  })
  .strict();
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;

export const statusResponseSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  result: z.enum(["applied", "noop", "conflict", "not_found"]),
  status: z.enum(["open", "done", "skipped"]).nullable(),
  version: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export const occurrenceIdFromExternal = (externalId: string): string | null => {
  const m = /^occ:([0-9a-f-]{36})$/.exec(externalId);
  return m ? m[1] : null;
};
