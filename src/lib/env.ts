import { z } from "zod";

/**
 * Variabili d'ambiente di Personal OS. I segreti sono letti SOLO lato server.
 * Credenziali SEPARATE da IronEdge: progetto Supabase dedicato, segreti dedicati.
 */
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
  NEXT_PUBLIC_APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  CRON_SECRET: z.string().min(32).optional(),
  SECURITY_INGEST_SECRET: z.string().min(32).optional(),
  APP_URL: z.url().optional(),
  // utente proprietario (single-user): abilita job, Security Center e integrazioni
  OWNER_USER_ID: z.uuid().optional(),
  // chiave di cifratura applicativa (32 byte base64) per i token OAuth
  TOKEN_ENCRYPTION_KEY: z.string().min(40).optional(),
  // IronEdge Growth OS (server-to-server, HMAC)
  IRONEDGE_BASE_URL: z.url().optional(),
  IRONEDGE_SHARED_SECRET: z.string().min(32).optional(),
  // Google Calendar (OAuth 2.0, client "Web application")
  GOOGLE_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
  // Telegram (bot DEDICATO a Personal OS, diverso da quello IronEdge)
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/).optional(),
  // Assistente AI (disattivato di default)
  AI_PROVIDER: z.enum(["none", "anthropic"]).default("none"),
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(0),
  AI_MAX_REQUESTS_PER_DAY: z.coerce.number().int().min(0).max(1000).default(30),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function clean(obj: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(obj)
      .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v] as const)
      .filter(([, v]) => v !== undefined && v !== ""),
  );
}

export function publicEnv(): PublicEnv {
  return publicSchema.parse(
    clean({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    }),
  );
}

export function serverEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  if (typeof window !== "undefined") throw new Error("serverEnv() non disponibile nel browser");
  const parsed = serverSchema.safeParse(clean(source));
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configurazione server non valida: ${names}`);
  }
  return parsed.data;
}

export function isSupabaseConfigured(): boolean {
  const e = publicEnv();
  return Boolean(e.NEXT_PUBLIC_SUPABASE_URL && e.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** Stato reale delle integrazioni: usato dall'interfaccia per non mostrare funzioni non operative. */
export function integrationStatus(env: ServerEnv = serverEnv()) {
  return {
    ironedge: Boolean(env.IRONEDGE_BASE_URL && env.IRONEDGE_SHARED_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY && env.APP_URL),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
    ai: env.AI_PROVIDER === "anthropic" && Boolean(env.ANTHROPIC_API_KEY) && env.AI_MONTHLY_BUDGET_USD > 0,
    cron: Boolean(env.CRON_SECRET && env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
