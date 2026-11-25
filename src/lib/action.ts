import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { log, redact } from "./security";
import { requireUser, type Ctx } from "./session";

/** Percorsi di ritorno ammessi: solo interni (niente open redirect). */
export function safeBack(v: FormDataEntryValue | null | undefined, fallback: string): string {
  const s = typeof v === "string" ? v : "";
  return /^\/(?!\/)[\w\-/?=&.%]*$/.test(s) && !s.includes("..") ? s : fallback;
}

/**
 * Esecuzione standard di una Server Action: contesto autenticato (RLS), errori trasformati in
 * messaggi sicuri, revalidazione e redirect con esito (?ok= / ?err=).
 */
export async function run(path: string, fn: (ctx: Ctx) => Promise<string | void>): Promise<never> {
  let message = "Salvato";
  let failed = false;
  try {
    const ctx = await requireUser();
    message = (await fn(ctx)) ?? "Salvato";
  } catch (e) {
    unstable_rethrow(e);
    failed = true;
    message = e instanceof Error && !/supabase|postgres|jwt/i.test(e.message) ? redact(e.message, 200) : "Operazione non riuscita";
    log.warn("azione fallita", e);
  }
  revalidatePath(path.split("?")[0]);
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}${failed ? "err" : "ok"}=${encodeURIComponent(message)}`);
}

export const str = (fd: FormData, k: string, max = 500) => String(fd.get(k) ?? "").trim().slice(0, max);
export const optStr = (fd: FormData, k: string, max = 500) => {
  const v = str(fd, k, max);
  return v ? v : null;
};
export const num = (fd: FormData, k: string): number | null => {
  const v = str(fd, k, 20).replace(",", ".");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
