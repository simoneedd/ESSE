"use server";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { run, str } from "@/lib/action";
import { aiStatus, askAi } from "@/lib/assistant/ai";
import { executeIntent } from "@/lib/assistant/execute";
import { parseIntent } from "@/lib/assistant/intents";
import { serverEnv } from "@/lib/env";
import { log, rateLimit, redact } from "@/lib/security";
import { must, requireUser } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase/server";
import { formatTime } from "@/lib/time";

/** Messaggio all'assistente: prima i comandi deterministici (gratis), poi l'AI se attiva e consentita. */
export async function askAssistantAction(fd: FormData) {
  let conv = z.uuid().safeParse(fd.get("conversation_id")).data ?? null;
  let err: string | null = null;
  try {
    const { db, user, profile, today, tz } = await requireUser();
    const message = str(fd, "message", 2000);
    if (!message) throw new Error("Scrivi un messaggio");
    if (!rateLimit(`assistant:${user.id}`, 30, 60_000)) throw new Error("Troppe richieste, attendi un minuto");
    if (!conv) conv = must(await db.from("ai_conversations").insert({ user_id: user.id, title: message.slice(0, 80) }).select("id").single()).id;
    must(await db.from("ai_messages").insert({ user_id: user.id, conversation_id: conv, role: "user", content: message }));
    let reply: string;
    let engine: "rules" | "ai" = "rules";
    const intent = parseIntent(message);
    if (intent) {
      reply = (await executeIntent(db, profile, intent, today)).reply;
    } else {
      const env = serverEnv();
      const status = aiStatus(env, profile.ai_consent);
      if (!status.enabled) {
        reply = `Non ho riconosciuto un comando. ${status.reason}\nScrivi "aiuto" per l'elenco dei comandi disponibili.`;
      } else {
        // contesto minimizzato: titoli e orari di oggi + memoria attiva; niente salute senza consenso separato
        const [blocks, memory] = await Promise.all([
          db.from("schedule_blocks").select("starts_at, title, area, kind").eq("plan_date", today).order("starts_at").limit(40),
          db.from("assistant_memory").select("content").eq("active", true).limit(30),
        ]);
        const items = (blocks.data ?? [])
          .filter((b) => profile.ai_share_health || !["health", "gym"].includes(b.area))
          .map((b) => `${formatTime(b.starts_at, tz)} [${b.area}] ${b.title}`);
        const out = await askAi(supabaseAdmin(), { userId: user.id, message, context: { today, items, memory: (memory.data ?? []).map((m) => m.content) } }, status, env);
        engine = "ai";
        if (out.kind === "intent") reply = (await executeIntent(db, profile, out.intent, today)).reply;
        else if (out.kind === "text") reply = `${out.text}\n\n(Risposta AI: verifica prima di agire.)`;
        else reply = out.error;
      }
    }
    must(await db.from("ai_messages").insert({ user_id: user.id, conversation_id: conv, role: "assistant", content: reply.slice(0, 20000), engine }));
  } catch (e) {
    unstable_rethrow(e);
    log.warn("assistente: errore", e);
    err = e instanceof Error ? redact(e.message, 200) : "Errore dell'assistente";
  }
  revalidatePath("/assistente");
  redirect(`/assistente?${conv ? `c=${conv}&` : ""}${err ? `err=${encodeURIComponent(err)}` : ""}`);
}

export async function newConversation() {
  redirect("/assistente?new=1");
}

export async function deleteConversation(fd: FormData) {
  await run("/assistente", async ({ db }) => {
    must(await db.from("ai_conversations").delete().eq("id", z.uuid().parse(fd.get("id"))));
    return "Conversazione eliminata";
  });
}
