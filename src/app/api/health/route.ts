import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Health check senza dati: nessuna informazione su configurazione o integrazioni. */
export function GET() {
  return NextResponse.json({ ok: true, service: "personal-os", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
