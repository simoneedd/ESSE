import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Logout solo via POST con verifica origine (no logout CSRF via GET). */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return NextResponse.json({ error: "Origine non valida" }, { status: 403 });
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", url.origin), { status: 303 });
}
