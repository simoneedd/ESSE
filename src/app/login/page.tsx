import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SubmitButton } from "@/components/SubmitButton";
import { Flash, readSp, type SP } from "@/components/ui";
import { isSupabaseConfigured } from "@/lib/env";
import { log, rateLimit } from "@/lib/security";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Accesso" };

async function clientKey() {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
}
async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
const emailSchema = z.email().max(254);

async function passwordLogin(fd: FormData) {
  "use server";
  const email = emailSchema.safeParse(String(fd.get("email") ?? "").trim().toLowerCase());
  const password = String(fd.get("password") ?? "");
  if (!email.success || password.length < 8 || password.length > 200) redirect("/login?err=Credenziali%20non%20valide");
  if (!rateLimit(`login:${await clientKey()}`, 5, 15 * 60_000)) redirect("/login?err=Troppi%20tentativi%2C%20riprova%20tra%2015%20minuti");
  const db = await supabaseServer();
  const { error } = await db.auth.signInWithPassword({ email: email.data, password });
  if (error) {
    log.warn("login fallito", { code: error.code, status: error.status });
    redirect("/login?err=Credenziali%20non%20valide");
  }
  redirect("/");
}

async function magicLink(fd: FormData) {
  "use server";
  const email = emailSchema.safeParse(String(fd.get("email") ?? "").trim().toLowerCase());
  if (!email.success) redirect("/login?err=Email%20non%20valida");
  if (!rateLimit(`login:${await clientKey()}`, 5, 15 * 60_000)) redirect("/login?err=Troppi%20tentativi");
  const db = await supabaseServer();
  // shouldCreateUser: false -> nessuna registrazione libera: l'account va creato dal proprietario in Supabase
  const { error } = await db.auth.signInWithOtp({ email: email.data, options: { emailRedirectTo: `${await origin()}/auth/callback`, shouldCreateUser: false } });
  if (error) log.warn("magic link non inviato", { code: error.code, status: error.status });
  redirect("/login?ok=Se%20l%27indirizzo%20e%27%20abilitato%20riceverai%20un%20link%20di%20accesso");
}

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  if (!isSupabaseConfigured()) redirect("/setup");
  const db = await supabaseServer();
  const { data } = await db.auth.getUser();
  if (data.user) redirect("/");
  return (
    <main id="contenuto" className="auth">
      <div className="card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">E</span><span>Esse<small className="meta">Personal OS</small></span></div>
        <Flash sp={sp} />
        <form action={passwordLogin} className="stack" aria-label="Accesso con password">
          <label>Email<input type="email" name="email" required autoComplete="email" maxLength={254} /></label>
          <label>Password<input type="password" name="password" required minLength={8} autoComplete="current-password" /></label>
          <SubmitButton>Accedi</SubmitButton>
        </form>
        <hr className="divider" />
        <form action={magicLink} className="stack" aria-label="Accesso con link via email">
          <label>Oppure ricevi un link via email<input type="email" name="email" required autoComplete="email" maxLength={254} /></label>
          <SubmitButton className="btn">Invia link</SubmitButton>
        </form>
        <p className="meta">Spazio personale e privato: nessuna registrazione pubblica.</p>
      </div>
    </main>
  );
}
