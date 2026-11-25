import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { integrationStatus, serverEnv } from "@/lib/env";
import { buildAuthUrl, pkcePair } from "@/lib/gcal";
import { rateLimit } from "@/lib/security";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Avvio OAuth Google: state anti-CSRF e verifier PKCE in cookie httpOnly di breve durata. */
export async function GET() {
  const env = serverEnv();
  if (!integrationStatus(env).google) return NextResponse.json({ error: "Google Calendar non configurato" }, { status: 503 });
  const db = await supabaseServer();
  const { data } = await db.auth.getUser();
  if (!data.user) return NextResponse.redirect(new URL("/login", env.APP_URL));
  if (!rateLimit(`gstart:${data.user.id}`, 10, 3600_000)) return NextResponse.json({ error: "Troppe richieste" }, { status: 429 });
  const state = randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkcePair();
  const res = NextResponse.redirect(buildAuthUrl({ clientId: env.GOOGLE_CLIENT_ID!, redirectUri: `${env.APP_URL}/api/google/callback`, state, challenge }));
  const opts = { httpOnly: true, secure: env.APP_URL!.startsWith("https://"), sameSite: "lax" as const, path: "/api/google", maxAge: 600 };
  res.cookies.set("g_state", state, opts);
  res.cookies.set("g_verifier", verifier, opts);
  return res;
}
