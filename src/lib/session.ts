import type { SupabaseClient, User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "./env";
import type { Profile } from "./plan-service";
import { supabaseServer } from "./supabase/server";
import { localDate } from "./time";

export type Ctx = { db: SupabaseClient; user: User; profile: Profile; today: string; tz: string };

/** Contesto autenticato (RLS). Reindirizza a /login senza sessione; crea il profilo al primo accesso. */
export async function requireUser(): Promise<Ctx> {
  if (!isSupabaseConfigured()) redirect("/setup");
  const db = await supabaseServer();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect("/login");
  let { data: profile } = await db.from("profiles").select("*").eq("user_id", auth.user.id).maybeSingle();
  if (!profile) {
    await db.rpc("ensure_profile");
    ({ data: profile } = await db.from("profiles").select("*").eq("user_id", auth.user.id).maybeSingle());
    if (!profile) throw new Error("Impossibile inizializzare il profilo");
  }
  const p = profile as Profile;
  return { db, user: auth.user, profile: p, tz: p.timezone, today: localDate(new Date(), p.timezone) };
}

/** Esito di una Server Action: errore come messaggio sicuro (nessun dettaglio interno). */
export function must<T>(r: { data: T; error: { message: string } | null }, msg = "Operazione non riuscita"): NonNullable<T> {
  if (r.error) throw new Error(`${msg}: ${r.error.message.slice(0, 160)}`);
  return r.data as NonNullable<T>;
}
