import { createServerClient } from "@supabase/ssr";
import { createClient as createPlainClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { publicEnv, serverEnv } from "../env";

/** Client con la sessione dell'utente (RLS attiva). Uso: Server Components, Server Actions, Route Handlers. */
export async function supabaseServer(): Promise<SupabaseClient> {
  const env = publicEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("Supabase non configurato");
  }
  const store = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // chiamato da un Server Component: il refresh della sessione avviene nel proxy
        }
      },
    },
  });
}

/**
 * Client service role: BYPASSA RLS. Solo per job schedulati, webhook verificati e ingest
 * di sicurezza autenticato. Mai importare da componenti client: la chiave resta sul server.
 */
export function supabaseAdmin(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("supabaseAdmin() vietato nel browser");
  const url = publicEnv().NEXT_PUBLIC_SUPABASE_URL;
  const key = serverEnv().SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Service role non configurato");
  return createPlainClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
