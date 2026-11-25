import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "./env";
import { buildEventBody, createGoogleClient, GoogleError, mapGoogleEvent, refreshAccessToken } from "./gcal";
import { decryptSecret, redact } from "./security";

/** Sincronizzazione Google Calendar per un utente (service role, sempre filtrata per user_id). */
export async function googleAccessToken(admin: SupabaseClient, userId: string, env: ServerEnv, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY) return null;
  const { data } = await admin.from("oauth_tokens").select("encrypted_refresh_token").eq("user_id", userId).eq("provider", "google").maybeSingle();
  if (!data) return null;
  const refreshToken = decryptSecret(data.encrypted_refresh_token, env.TOKEN_ENCRYPTION_KEY, `google:${userId}`);
  const t = await refreshAccessToken({ refreshToken, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }, fetchImpl);
  return t.access_token;
}

export async function syncGoogleCalendar(admin: SupabaseClient, userId: string, env: ServerEnv, fetchImpl: typeof fetch = fetch) {
  const stats = { imported: 0, updated: 0, removed: 0, exported: 0, patched: 0, errors: 0 };
  const token = await googleAccessToken(admin, userId, env, fetchImpl);
  if (!token) return { skipped: "Google Calendar non collegato" };
  const g = createGoogleClient(token, fetchImpl);
  const { data: maps } = await admin.from("calendar_mappings").select("id, area, gcal_calendar_id, read_enabled, write_enabled, sync_token").eq("user_id", userId);
  const now = Date.now();
  const timeMin = new Date(now - 7 * 86_400_000).toISOString();
  const timeMax = new Date(now + 45 * 86_400_000).toISOString();

  // 1) import (solo lettura) dai calendari abilitati
  for (const m of maps ?? []) {
    if (!m.read_enabled) continue;
    try {
      let res;
      try {
        res = await g.listEvents(m.gcal_calendar_id, m.sync_token ? { syncToken: m.sync_token } : { timeMin, timeMax });
      } catch (e) {
        if (e instanceof GoogleError && e.status === 410) res = await g.listEvents(m.gcal_calendar_id, { timeMin, timeMax });
        else throw e;
      }
      for (const ge of res.items) {
        const ev = mapGoogleEvent(ge);
        if (!ev) continue;
        if (ev.cancelled) {
          // l'evento e' stato cancellato IN Google: si rimuove solo la copia locale importata (origin=google)
          const del = await admin.from("events").delete().eq("user_id", userId).eq("gcal_event_id", ev.gcal_event_id).eq("origin", "google").select("id");
          stats.removed += del.data?.length ?? 0;
          continue;
        }
        const { cancelled: _c, ...fields } = ev;
        const up = await admin
          .from("events")
          .upsert(
            { ...fields, user_id: userId, area: m.area, gcal_calendar_id: m.gcal_calendar_id, origin: "google", flexibility: "fixed", kind: ev.involves_others ? "meeting" : "appointment", gcal_synced_at: new Date().toISOString() },
            { onConflict: "user_id,gcal_event_id" },
          );
        if (up.error) stats.errors++;
        else stats.imported++;
      }
      await admin.from("calendar_mappings").update({ sync_token: res.nextSyncToken }).eq("id", m.id);
    } catch (e) {
      stats.errors++;
      await admin.from("sync_log").insert({ user_id: userId, provider: "google_calendar", direction: "pull", outcome: "error", detail: redact(e, 300) });
    }
  }

  // 2) export degli eventi creati in Personal OS verso il calendario dell'area (solo se scrittura autorizzata)
  const writable = new Map((maps ?? []).filter((m) => m.write_enabled).map((m) => [m.area as string, m.gcal_calendar_id as string]));
  if (writable.size) {
    const { data: local } = await admin
      .from("events")
      .select("id, title, area, starts_at, ends_at, location, gcal_event_id, gcal_calendar_id, gcal_synced_at, updated_at")
      .eq("user_id", userId)
      .eq("origin", "personal_os")
      .gte("starts_at", timeMin)
      .lte("starts_at", timeMax)
      .limit(200);
    for (const ev of local ?? []) {
      const cal = writable.get(ev.area);
      if (!cal) continue;
      try {
        const body = buildEventBody(ev);
        if (!ev.gcal_event_id) {
          const existing = await g.findByPosId(cal, ev.id); // idempotenza dopo un errore di rete
          const created = existing ?? (await g.insertEvent(cal, body));
          await admin.from("events").update({ gcal_event_id: created.id, gcal_calendar_id: cal, gcal_etag: created.etag ?? null, gcal_synced_at: new Date().toISOString() }).eq("id", ev.id).eq("user_id", userId);
          stats.exported++;
        } else if (!ev.gcal_synced_at || ev.updated_at > ev.gcal_synced_at) {
          const patched = await g.patchEvent(ev.gcal_calendar_id ?? cal, ev.gcal_event_id, body);
          await admin.from("events").update({ gcal_etag: patched.etag ?? null, gcal_synced_at: new Date().toISOString() }).eq("id", ev.id).eq("user_id", userId);
          stats.patched++;
        }
      } catch (e) {
        stats.errors++;
        await admin.from("sync_log").insert({ user_id: userId, provider: "google_calendar", direction: "push", outcome: "error", entity_id: ev.id, detail: redact(e, 300) });
      }
    }
  }
  await admin.from("integration_state").upsert(
    { user_id: userId, provider: "google_calendar", enabled: true, last_success_at: stats.errors ? undefined : new Date().toISOString(), last_error: stats.errors ? `${stats.errors} errori nell'ultimo ciclo` : null },
    { onConflict: "user_id,provider" },
  );
  await admin.from("sync_log").insert({ user_id: userId, provider: "google_calendar", direction: "pull", outcome: stats.errors ? "error" : "ok", stats });
  return stats;
}
