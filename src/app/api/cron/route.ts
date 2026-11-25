import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env";
import { runScheduler } from "@/lib/jobs";
import { bearer, log, rateLimit, redact, safeEqual } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Scheduler cloud: chiamato ogni 15 minuti da GitHub Actions con Authorization: Bearer $CRON_SECRET. */
export async function POST(req: Request) {
  const env = serverEnv();
  if (!env.CRON_SECRET || !env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "Scheduler non configurato" }, { status: 503 });
  if (!rateLimit("cron", 12, 3600_000)) return NextResponse.json({ error: "Troppe richieste" }, { status: 429 });
  if (!safeEqual(bearer(req.headers.get("authorization")), env.CRON_SECRET)) return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
  try {
    const results = await runScheduler(supabaseAdmin(), env);
    return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), results });
  } catch (e) {
    log.error("scheduler fallito", e);
    return NextResponse.json({ ok: false, error: redact(e, 200) }, { status: 500 });
  }
}
