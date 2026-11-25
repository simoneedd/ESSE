import Link from "next/link";
import { z } from "zod";
import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Card, Flash, PageHeader, readSp, type SP } from "@/components/ui";
import { aiStatus } from "@/lib/assistant/ai";
import { serverEnv } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { askAssistantAction, deleteConversation } from "./actions";

export const metadata = { title: "Assistente" };

const SUGGESTIONS = [
  "Organizzami la giornata di domani",
  "Oggi ho dormito sei ore, riorganizza le mie attivita'",
  "Inserisci quattro allenamenti questa settimana",
  "Trovami un'ora al giorno per studiare",
  "Quali clienti sto trascurando?",
  "Quanto tempo ho dedicato al marketing questa settimana?",
];

export default async function AssistantPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, profile } = await requireUser();
  const convs = (await db.from("ai_conversations").select("id, title, updated_at").order("updated_at", { ascending: false }).limit(15)).data ?? [];
  const requested = z.uuid().safeParse(sp.c).data;
  const current = sp.new ? null : (requested ?? convs[0]?.id ?? null);
  const messages = current ? ((await db.from("ai_messages").select("id, role, content, engine").eq("conversation_id", current).order("created_at").limit(200)).data ?? []) : [];
  const ai = aiStatus(serverEnv(), profile.ai_consent);
  return (
    <>
      <PageHeader
        title="Assistente"
        sub="Parla normalmente: pianifico, riorganizzo e rispondo usando solo i tuoi dati."
        actions={<><Badge tone={ai.enabled ? "accent" : undefined}>{ai.enabled ? `AI attiva (${ai.model})` : "Comandi predefiniti"}</Badge><Link className="btn small" href="/assistente?new=1">Nuova conversazione</Link></>}
      />
      <Flash sp={sp} />
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 1fr)" }}>
        <Card>
          <div className="chat" aria-live="polite">
            {messages.length === 0 ? (
              <div className="stack">
                <p className="meta">Esempi di richieste:</p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <form action={askAssistantAction} key={s}><input type="hidden" name="message" value={s} /><button className="btn small" type="submit">{s}</button></form>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.content}
                  {m.role === "assistant" && m.engine === "ai" ? <div className="meta" style={{ marginTop: 6 }}>Generato con AI</div> : null}
                </div>
              ))
            )}
          </div>
          <form action={askAssistantAction} className="composer">
            {current ? <input type="hidden" name="conversation_id" value={current} /> : null}
            <label className="sr-only" htmlFor="msg">Messaggio</label>
            <input id="msg" name="message" required maxLength={2000} placeholder="Scrivi una richiesta…" autoComplete="off" />
            <SubmitButton>Invia</SubmitButton>
          </form>
          {!ai.enabled ? <p className="meta">{ai.reason}</p> : <p className="meta">Le richieste libere usano l&apos;AI con dati minimizzati; le modifiche a impegni fissi richiedono sempre la tua approvazione.</p>}
        </Card>
        <Card title="Conversazioni">
          {convs.length ? (
            <ul className="list">
              {convs.map((c) => (
                <li key={c.id}>
                  <Link className="grow truncate" href={`/assistente?c=${c.id}`} aria-current={c.id === current ? "page" : undefined}>{c.title}</Link>
                  <form action={deleteConversation}><input type="hidden" name="id" value={c.id} /><button className="btn ghost small" type="submit" aria-label={`Elimina ${c.title}`}>×</button></form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="meta">Nessuna conversazione.</p>
          )}
          <p className="meta">Preferenze e decisioni memorizzate: <Link href="/impostazioni#memoria">gestisci la memoria</Link>.</p>
        </Card>
      </div>
    </>
  );
}
