import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Confronto a tempo costante di segreti (header webhook, bearer cron). */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function bearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[telegram-token]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, "[anthropic-key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt]"],
  [/\b(sb_secret|sb_publishable)_[A-Za-z0-9_-]{10,}\b/g, "[supabase-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[github-token]"],
  [/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^\s"',;]{6,})/gi, "$1$2[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\+?\d[\d\s-]{8,}\d/g, "[phone]"],
];

/** Redazione di segreti e dati personali prima di log o salvataggio errori. */
export function redact(input: unknown, maxLen = 500): string {
  let s: string;
  if (input instanceof Error) s = `${input.name}: ${input.message}`;
  else if (typeof input === "string") s = input;
  else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export const log = {
  info: (msg: string, meta?: unknown) => console.info(`[info] ${msg}`, meta === undefined ? "" : redact(meta)),
  warn: (msg: string, meta?: unknown) => console.warn(`[warn] ${msg}`, meta === undefined ? "" : redact(meta)),
  error: (msg: string, meta?: unknown) => console.error(`[error] ${msg}`, meta === undefined ? "" : redact(meta)),
};

/**
 * Rate limiter a finestra scorrevole in memoria. Limite noto: e' per-istanza
 * (in serverless ogni istanza ha il proprio contatore). Per limiti rigorosi
 * (es. budget AI) si usa anche il conteggio persistente su database.
 */
const buckets = new Map<string, number[]>();
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return true;
}

/** Solo URL https pubblici: niente javascript:, data:, http:, credenziali o host locali. */
export function isSafePublicUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return false;
  return host.includes(".");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Cifratura applicativa AES-256-GCM (token OAuth). Chiave da env TOKEN_ENCRYPTION_KEY
// (32 byte in base64). Formato: v1.<iv>.<tag>.<ciphertext> (base64url).
// ---------------------------------------------------------------------------

function keyFrom(b64: string | undefined): Buffer {
  if (!b64) throw new Error("TOKEN_ENCRYPTION_KEY mancante");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY deve essere di 32 byte (base64)");
  return key;
}

export function encryptSecret(plain: string, keyB64: string | undefined, aad = "personal-os"): string {
  const key = keyFrom(keyB64);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(token: string, keyB64: string | undefined, aad = "personal-os"): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Formato cifrato non valido");
  const d = createDecipheriv("aes-256-gcm", keyFrom(keyB64), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
