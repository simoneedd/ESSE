import { NextResponse } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { bearer, log, rateLimit, safeEqual } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const findingSchema = z.object({
  fingerprint: z.string().min(1).max(200),
  severity: z.enum(["info", "low", "moderate", "high", "critical"]),
  title: z.string().min(1).max(300),
  description: z.string().max(4000).optional(), // ricevuto ma non salvato (minimizzazione)
  package_name: z.string().max(200).optional(),
  fixed_version: z.string().max(100).optional(),
});
const payloadSchema = z.object({
  scanner: z.enum(["npm-audit", "osv-scanner", "gitleaks", "secret-scan", "semgrep", "dependency-review", "manual-review"]),
  complete: z.boolean().default(true),
  findings: z.array(findingSchema).max(2000),
});

/**
 * Ingest dei risultati delle scansioni CI (GitHub Actions) nel Security Center.
 * Autenticazione: Bearer SECURITY_INGEST_SECRET. Se la scansione e' completa, i finding
 * aperti non piu' rilevati vengono marcati "fixed" (con nota automatica).
 */
export async function POST(req: Request) {
  const env = serverEnv();
  if (!env.SECURITY_INGEST_SECRET) return NextResponse.json({ error: "Ingest non configurato" }, { status: 503 });
  if (!rateLimit("sec-ingest", 30, 3600_000)) return NextResponse.json({ error: "Troppe richieste" }, { status: 429 });
  if (!safeEqual(bearer(req.headers.get("authorization")), env.SECURITY_INGEST_SECRET)) {
    return NextResponse.json({ error: "Non autorizzato" }, { status: 401 });
  }
  const parsed = payloadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Payload non valido" }, { status: 400 });

  const { scanner, findings, complete } = parsed.data;
  const admin = supabaseAdmin();
  const now = new Date().toISOString();

  const { data: existing, error: exErr } = await admin.from("security_findings").select("fingerprint, status").eq("scanner", scanner);
  if (exErr) return NextResponse.json({ error: "Errore database" }, { status: 500 });
  const known = new Map((existing ?? []).map((f) => [f.fingerprint, f.status as string]));

  for (const f of findings) {
    const prev = known.get(f.fingerprint);
    if (prev) {
      // aggiorna solo last_seen; un finding risolto che ricompare viene riaperto
      const patch: Record<string, unknown> = { last_seen: now };
      if (prev === "fixed") {
        patch.status = "open";
      }
      await admin.from("security_findings").update(patch).eq("scanner", scanner).eq("fingerprint", f.fingerprint);
    } else {
      const { description: _d, ...row } = f;
      await admin.from("security_findings").insert({ ...row, scanner, first_seen: now, last_seen: now });
    }
  }

  let resolved = 0;
  if (complete) {
    const current = new Set(findings.map((f) => f.fingerprint));
    const gone = [...known.entries()].filter(([fp, st]) => !current.has(fp) && st === "open").map(([fp]) => fp);
    if (gone.length) {
      await admin
        .from("security_findings")
        .update({ status: "fixed" })
        .eq("scanner", scanner)
        
        .in("fingerprint", gone);
      resolved = gone.length;
    }
  }
  log.info(`security ingest ${scanner}`, { received: findings.length, resolved });
  return NextResponse.json({ ok: true, received: findings.length, resolved });
}
