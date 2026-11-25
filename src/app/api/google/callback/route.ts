import { NextResponse } from "next/server";
import { integrationStatus, serverEnv } from "@/lib/env";
import { exchangeCode, GOOGLE_SCOPES } from "@/lib/gcal";
import { encryptSecret, log, safeEqual } from "@/lib/security";
import { supabaseAdmin, supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const env = serverEnv();
  const back = (msg: string, ok = false) => {
    const r = NextResponse.redirect(new URL(`/impostazioni?${ok ? "ok" : "err"}=${encodeURIComponent(msg)}#integrazioni`, env.APP_URL ?? req.url));
    r.cookies.delete({ name: "g_state", path: "/api/google" });
    r.cookies.delete({ name: "g_verifier", path: "/api/google" });
    return r;
  };
  if (!integrationStatus(env).google) return back("Google Calendar non configurato");
  const url = new URL(req.url);
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookie = (n: string) => new RegExp(`(?:^|; )${n}=([^;]+)`).exec(cookieHeader)?.[1] ?? null;
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return back("Autorizzazione Google annullata");
  if (!code || !safeEqual(state, cookie("g_state")) || !cookie("g_verifier")) return back("Richiesta non valida o scaduta: riprova");
  const db = await supabaseServer();
  const { data } = await db.auth.getUser();
  if (!data.user) return back("Sessione scaduta");
  try {
    const t = await exchangeCode({ code, verifier: cookie("g_verifier")!, clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, redirectUri: `${env.APP_URL}/api/google/callback` });
    const granted = (t.scope ?? "").split(" ");
    if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) return back("Permessi Google insufficienti: concedi l'accesso agli eventi e all'elenco calendari");
    if (!t.refresh_token) return back("Google non ha fornito un token di aggiornamento: rimuovi l'accesso dall'account Google e ricollega");
    const admin = supabaseAdmin();
    const { error } = await admin.from("oauth_tokens").upsert({
      user_id: data.user.id, provider: "google", scopes: granted.join(" "),
      encrypted_refresh_token: encryptSecret(t.refresh_token, env.TOKEN_ENCRYPTION_KEY, `google:${data.user.id}`),
    }, { onConflict: "user_id,provider" });
    if (error) throw new Error(error.message);
    await admin.from("integration_state").upsert({ user_id: data.user.id, provider: "google_calendar", enabled: true }, { onConflict: "user_id,provider" });
    await admin.from("audit_events").insert({ user_id: data.user.id, actor: "user", action: "connect", entity: "google_calendar" });
    return back("Google Calendar collegato: configura i calendari per area", true);
  } catch (e) {
    log.warn("oauth google fallito", e);
    return back("Collegamento Google non riuscito");
  }
}
