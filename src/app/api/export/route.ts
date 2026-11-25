import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { rateLimit } from "@/lib/security";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TABLES = [
  "profiles", "clients", "projects", "tasks", "events", "schedule_blocks", "plan_proposals", "time_entries", "sleep_logs", "wake_plans",
  "meal_plans", "meal_plan_items", "meal_logs", "hydration_logs", "shopping_items", "workout_templates", "template_exercises",
  "workout_sessions", "session_sets", "trading_sessions", "study_items", "study_sessions", "study_notes", "habits", "habit_logs",
  "ai_conversations", "ai_messages", "assistant_memory", "calendar_mappings", "notifications", "reports", "sync_log", "audit_events",
] as const;

/** Export completo dei propri dati (portabilita'), letto con RLS: solo righe dell'utente. Nessun token. */
export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "Non configurato" }, { status: 503 });
  const db = await supabaseServer();
  const { data } = await db.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "Non autenticato" }, { status: 401 });
  if (!rateLimit(`export:${data.user.id}`, 5, 3600_000)) return NextResponse.json({ error: "Troppe richieste" }, { status: 429 });
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), app: "personal-os" };
  for (const t of TABLES) {
    const { data: rows, error } = await db.from(t).select("*").limit(50_000);
    out[t] = error ? { error: "non esportabile" } : rows;
  }
  return new NextResponse(JSON.stringify(out, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="personal-os-export-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" },
  });
}
