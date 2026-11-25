/**
 * Google Calendar via OAuth 2.0 (Authorization Code + PKCE, accesso offline).
 * Sicurezza e integrita':
 *  - scope minimi: calendar.events (eventi) + calendar.calendarlist.readonly (scelta calendari);
 *  - refresh token cifrato AES-256-GCM lato server (tabella oauth_tokens, nessun accesso client);
 *  - anti-duplicati: ogni evento creato da Personal OS porta extendedProperties.private.pos_id;
 *    l'import salta gli eventi con pos_origin=personal_os (evita la sincronizzazione circolare);
 *  - nessuna eliminazione involontaria: Personal OS non elimina MAI eventi nati in Google;
 *    elimina/aggiorna solo eventi che ha creato lui, e solo su richiesta esplicita;
 *  - scrittura solo sui calendari con write_enabled = true (autorizzazione per area).
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number(), refresh_token: z.string().optional(), scope: z.string().optional() });

export class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new GoogleError(`OAuth Google HTTP ${res.status}`, res.status, res.status >= 500);
  const parsed = tokenSchema.safeParse(json);
  if (!parsed.success) throw new GoogleError("Risposta token non valida", res.status, false);
  return parsed.data;
}

export function exchangeCode(p: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }, fetchImpl: typeof fetch = fetch) {
  return tokenRequest({ code: p.code, code_verifier: p.verifier, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: "authorization_code" }, fetchImpl);
}

export function refreshAccessToken(p: { refreshToken: string; clientId: string; clientSecret: string }, fetchImpl: typeof fetch = fetch) {
  return tokenRequest({ refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret, grant_type: "refresh_token" }, fetchImpl);
}

export const gEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  etag: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  attendees: z.array(z.object({ email: z.string().optional(), self: z.boolean().optional() })).optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
export type GEvent = z.infer<typeof gEventSchema>;

export type ImportedEvent = {
  gcal_event_id: string;
  gcal_etag: string | null;
  title: string;
  location: string | null;
  starts_at: string;
  ends_at: string;
  involves_others: boolean;
  is_external: boolean;
  cancelled: boolean;
};

/** Mappa un evento Google in evento locale. null = da non importare (creato da noi o tutto il giorno). */
export function mapGoogleEvent(e: GEvent): ImportedEvent | null {
  if (e.extendedProperties?.private?.pos_origin === "personal_os") return null; // anti-loop
  const cancelled = e.status === "cancelled";
  if (!cancelled && (!e.start?.dateTime || !e.end?.dateTime)) return null; // eventi "tutto il giorno": non bloccano l'agenda
  const others = (e.attendees ?? []).filter((a) => !a.self).length;
  return {
    gcal_event_id: e.id,
    gcal_etag: e.etag ?? null,
    title: (e.summary ?? "(senza titolo)").slice(0, 200),
    location: e.location?.slice(0, 200) ?? null,
    starts_at: e.start?.dateTime ? new Date(e.start.dateTime).toISOString() : new Date(0).toISOString(),
    ends_at: e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : new Date(0).toISOString(),
    involves_others: others > 0,
    is_external: others > 0 && e.organizer?.self === false,
    cancelled,
  };
}

/** Corpo evento creato da Personal OS (marcato per evitare duplicati e cicli). */
export function buildEventBody(local: { id: string; title: string; starts_at: string; ends_at: string; location?: string | null; reminderMinutes?: number | null }) {
  return {
    summary: local.title.slice(0, 200),
    location: local.location ?? undefined,
    start: { dateTime: local.starts_at },
    end: { dateTime: local.ends_at },
    reminders: local.reminderMinutes != null ? { useDefault: false, overrides: [{ method: "popup", minutes: local.reminderMinutes }] } : { useDefault: true },
    extendedProperties: { private: { pos_origin: "personal_os", pos_id: local.id } },
  };
}

export function createGoogleClient(accessToken: string, fetchImpl: typeof fetch = fetch) {
  async function call(method: string, path: string, query?: Record<string, string>, body?: unknown) {
    const u = new URL(API + path);
    if (query) u.search = new URLSearchParams(query).toString();
    const res = await fetchImpl(u, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 410) throw new GoogleError("syncToken scaduto", 410, false);
    if (!res.ok) throw new GoogleError(`Google Calendar HTTP ${res.status}`, res.status, res.status >= 500 || res.status === 429);
    return res.status === 204 ? null : res.json();
  }
  return {
    async listCalendars() {
      const j = (await call("GET", "/users/me/calendarList", { minAccessRole: "reader" })) as { items?: { id: string; summary: string; accessRole: string; primary?: boolean }[] };
      return (j.items ?? []).map((c) => ({ id: c.id, summary: c.summary, accessRole: c.accessRole, primary: Boolean(c.primary) }));
    },
    /** Lettura incrementale: con syncToken solo le modifiche; senza, la finestra temporale. Paginata. */
    async listEvents(calendarId: string, opts: { syncToken?: string | null; timeMin?: string; timeMax?: string }) {
      const items: GEvent[] = [];
      let pageToken: string | undefined;
      let nextSyncToken: string | null = null;
      for (let i = 0; i < 20; i++) {
        const q: Record<string, string> = { singleEvents: "true", maxResults: "250", showDeleted: "true" };
        if (opts.syncToken) q.syncToken = opts.syncToken;
        else {
          if (opts.timeMin) q.timeMin = opts.timeMin;
          if (opts.timeMax) q.timeMax = opts.timeMax;
        }
        if (pageToken) q.pageToken = pageToken;
        const j = (await call("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, q)) as { items?: unknown[]; nextPageToken?: string; nextSyncToken?: string };
        for (const it of j.items ?? []) {
          const p = gEventSchema.safeParse(it);
          if (p.success) items.push(p.data);
        }
        pageToken = j.nextPageToken;
        nextSyncToken = j.nextSyncToken ?? nextSyncToken;
        if (!pageToken) break;
      }
      return { items, nextSyncToken };
    },
    /** Cerca un evento gia' creato da noi (idempotenza dopo errori di rete). */
    async findByPosId(calendarId: string, posId: string) {
      const j = (await call("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, { privateExtendedProperty: `pos_id=${posId}`, maxResults: "1" })) as { items?: unknown[] };
      const p = gEventSchema.safeParse(j.items?.[0]);
      return p.success ? p.data : null;
    },
    insertEvent: (calendarId: string, body: ReturnType<typeof buildEventBody>) => call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, undefined, body) as Promise<GEvent>,
    patchEvent: (calendarId: string, eventId: string, body: Partial<ReturnType<typeof buildEventBody>>) =>
      call("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, undefined, body) as Promise<GEvent>,
  };
}
