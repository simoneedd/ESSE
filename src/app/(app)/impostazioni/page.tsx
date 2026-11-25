import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Card, Empty, Flash, PageHeader, readSp, type SP } from "@/components/ui";
import { aiStatus } from "@/lib/assistant/ai";
import { AREA_LABEL, CALENDAR_AREAS, LIFE_AREAS } from "@/lib/domain";
import { integrationStatus, serverEnv } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { formatLocal } from "@/lib/time";
import { deleteAllData, disconnectGoogle, saveCalendarMapping, saveMemory, savePrivacy, saveProfile } from "./actions";

export const metadata = { title: "Impostazioni" };
const DOW = ["", "Lunedi'", "Martedi'", "Mercoledi'", "Giovedi'", "Venerdi'", "Sabato", "Domenica"];

export default async function SettingsPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, profile, tz, user } = await requireUser();
  const env = serverEnv();
  const st = integrationStatus(env);
  const ai = aiStatus(env, profile.ai_consent);
  const [memory, states, maps, log, usage] = await Promise.all([
    db.from("assistant_memory").select("id, kind, content, active, source, created_at").order("created_at", { ascending: false }),
    db.from("integration_state").select("provider, enabled, last_success_at, last_error, consecutive_failures").eq("user_id", user.id),
    db.from("calendar_mappings").select("area, gcal_calendar_id, read_enabled, write_enabled"),
    db.from("sync_log").select("id, provider, direction, outcome, detail, created_at").order("created_at", { ascending: false }).limit(25),
    db.from("ai_usage").select("estimated_cost_usd, created_at").gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
  ]);
  const sched = profile.schedule as Record<string, string | number>;
  const state = (p: string) => (states.data ?? []).find((s) => s.provider === p);
  const hasGoogle = Boolean(state("google_calendar")) || (maps.data ?? []).length > 0;
  const spent = (usage.data ?? []).reduce((a, u) => a + Number(u.estimated_cost_usd), 0);
  const status = (ok: boolean, label?: string) => <Badge tone={ok ? "accent" : undefined}>{ok ? (label ?? "configurato") : "non configurato"}</Badge>;
  return (
    <>
      <PageHeader title="Impostazioni" sub="Vincoli personali, autonomia dell'assistente, notifiche, privacy e integrazioni." />
      <Flash sp={sp} />
      <div className="stack">
        <Card title="Profilo, sonno e lavoro">
          <form action={saveProfile} className="stack">
            <div className="form-grid">
              <label>Nome visualizzato<input name="display_name" maxLength={80} defaultValue={profile.display_name ?? ""} /></label>
              <label>Fuso orario<input name="timezone" maxLength={60} defaultValue={profile.timezone} /></label>
              <label>Obiettivo sonno (ore)<input type="number" name="sleep_goal_hours" min={4} max={12} step={0.25} defaultValue={profile.sleep_goal_minutes / 60} /></label>
              <label>Coricarsi<input type="time" name="target_bedtime" defaultValue={profile.target_bedtime.slice(0, 5)} /></label>
              <label>Sveglia<input type="time" name="target_wake" defaultValue={profile.target_wake.slice(0, 5)} /></label>
              <label>Inizio lavoro<input type="time" name="workday_start" defaultValue={profile.workday_start.slice(0, 5)} /></label>
              <label>Fine lavoro<input type="time" name="workday_end" defaultValue={profile.workday_end.slice(0, 5)} /></label>
              <label>Max ore lavoro/giorno<input type="number" name="max_work_hours" min={1} max={16} step={0.5} defaultValue={profile.max_work_minutes_per_day / 60} /></label>
              <label>Margine imprevisti (%)<input type="number" name="buffer_percent" min={0} max={50} defaultValue={profile.buffer_percent} /></label>
            </div>
            <fieldset className="stack-s" style={{ border: 0, padding: 0 }}>
              <legend><h3>Attivita&apos; flessibili che l&apos;assistente puo&apos; riprogrammare da solo</h3></legend>
              <div className="row">{LIFE_AREAS.map((a) => <label key={a} className="check"><input type="checkbox" name={`auto_${a}`} defaultChecked={profile.auto_reschedule_areas.includes(a)} /> {AREA_LABEL[a]}</label>)}</div>
              <p className="meta">Impegni fissi, riunioni con altre persone ed eventi esterni richiedono sempre la tua approvazione. Puoi anche impostare l&apos;autonomia sulla singola task.</p>
            </fieldset>
            <h3>Briefing e notifiche</h3>
            <div className="form-grid">
              <label>Briefing mattutino<input type="time" name="morning_briefing" defaultValue={String(sched.morning_briefing ?? "07:45")} /></label>
              <label>Revisione serale<input type="time" name="evening_review" defaultValue={String(sched.evening_review ?? "21:30")} /></label>
              <label>Promemoria serale (min prima)<input type="number" name="bedtime_offset" min={0} max={180} defaultValue={Number(sched.bedtime_reminder_offset_min ?? 45)} /></label>
              <label>Promemoria attivita&apos; (min prima)<input type="number" name="task_reminder_min" min={0} max={120} defaultValue={Number(sched.task_reminder_min ?? 10)} /></label>
              <label>Report settimanale<select name="weekly_report_dow" defaultValue={String(sched.weekly_report_dow ?? 7)}>{[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DOW[d]}</option>)}</select></label>
              <label>Ora report<input type="time" name="weekly_report" defaultValue={String(sched.weekly_report ?? "18:00")} /></label>
              <label>Report mensile (giorno)<input type="number" name="monthly_report_day" min={1} max={28} defaultValue={Number(sched.monthly_report_day ?? 1)} /></label>
            </div>
            <p className="meta">Le automazioni girano nel cloud ogni 15 minuti (GitHub Actions): i promemoria possono arrivare con qualche minuto di ritardo.</p>
            <SubmitButton>Salva</SubmitButton>
          </form>
        </Card>

        <Card title="Privacy e canali">
          <form action={savePrivacy} className="stack">
            <label className="check"><input type="checkbox" name="ai_consent" defaultChecked={profile.ai_consent} /> Consento l&apos;invio di dati minimizzati (titoli e orari di oggi, memoria) al provider AI per le richieste libere</label>
            <label className="check"><input type="checkbox" name="ai_share_health" defaultChecked={profile.ai_share_health} /> Includi anche attivita&apos; di benessere/palestra (mai diario alimentare o dati del sonno grezzi)</label>
            <div className="form-grid">
              <label>Conservazione dati (giorni)<input type="number" name="retention_days" min={30} max={3650} defaultValue={profile.retention_days} /></label>
              <label>Chat Telegram (ID numerico)<input name="telegram_chat_id" inputMode="numeric" maxLength={20} defaultValue={profile.telegram_chat_id ?? ""} /></label>
              <label className="check"><input type="checkbox" name="telegram_opt_in" defaultChecked={profile.telegram_opt_in} /> Ricevi notifiche su Telegram</label>
            </div>
            <SubmitButton>Salva privacy</SubmitButton>
          </form>
          <p className="meta">Assistente AI: {ai.enabled ? `attivo (${ai.model}), speso questo mese ${spent.toFixed(2)} / ${env.AI_MONTHLY_BUDGET_USD} USD, max ${env.AI_MAX_REQUESTS_PER_DAY} richieste/giorno` : ai.reason}</p>
          <div className="row"><a className="btn small" href="/api/export">Esporta tutti i miei dati (JSON)</a></div>
        </Card>

        <Card title="Memoria dell'assistente">
          <div id="memoria" />
          {memory.data?.length ? (
            <ul className="list">{memory.data.map((m) => (
              <li key={m.id}>
                <form action={saveMemory} className="row grow">
                  <input type="hidden" name="id" value={m.id} />
                  <select name="kind" defaultValue={m.kind} style={{ width: "auto" }} aria-label="Tipo"><option value="preference">Preferenza</option><option value="decision">Decisione</option><option value="fact">Fatto</option><option value="constraint">Vincolo</option></select>
                  <input name="content" defaultValue={m.content} maxLength={1000} className="grow" style={{ width: "auto" }} aria-label="Contenuto" />
                  <button className="btn small" type="submit">Salva</button>
                  <button className="btn ghost small danger" type="submit" name="delete" value="1">Elimina</button>
                </form>
              </li>
            ))}</ul>
          ) : <Empty>Nessun ricordo. Scrivi all&apos;assistente &quot;Ricorda che…&quot; oppure aggiungilo qui.</Empty>}
          <form action={saveMemory} className="row">
            <select name="kind" defaultValue="preference" style={{ width: "auto" }} aria-label="Tipo"><option value="preference">Preferenza</option><option value="decision">Decisione</option><option value="fact">Fatto</option><option value="constraint">Vincolo</option></select>
            <input name="content" placeholder="es. Preferisco allenarmi la mattina" maxLength={1000} className="grow" style={{ width: "auto" }} required aria-label="Nuovo ricordo" />
            <SubmitButton className="btn small">Aggiungi</SubmitButton>
          </form>
        </Card>

        <Card title="Integrazioni">
          <div id="integrazioni" />
          <ul className="list">
            <li><b className="grow">IronEdge Growth OS</b>{status(st.ironedge)}{state("ironedge")?.last_success_at ? <span className="meta">ultima sync {formatLocal(state("ironedge")!.last_success_at!, tz)}</span> : null}{state("ironedge")?.last_error ? <Badge tone="warning">{state("ironedge")!.last_error!.slice(0, 80)}</Badge> : null}</li>
            <li><b className="grow">Google Calendar</b>{status(st.google)}{st.google ? (hasGoogle ? <form action={disconnectGoogle}><button className="btn small" type="submit">Sospendi</button></form> : <a className="btn small primary" href="/api/google/start">Collega</a>) : null}</li>
            <li><b className="grow">Telegram (bot dedicato)</b>{status(st.telegram)}{profile.telegram_opt_in ? <Badge tone="accent">opt-in attivo</Badge> : null}</li>
            <li><b className="grow">Scheduler cloud</b>{status(st.cron)}</li>
            <li><b className="grow">Assistente AI</b>{status(st.ai, "disponibile")}</li>
          </ul>
          {st.google ? (
            <details>
              <summary>Calendari per area</summary>
              <form action={saveCalendarMapping} className="stack" style={{ marginTop: 10 }}>
                <p className="meta">Indica l&apos;ID di ciascun calendario Google (Impostazioni del calendario › Integra calendario). Lettura = importa gli impegni come fissi; Scrittura = crea in Google gli eventi creati in Personal OS per quell&apos;area.</p>
                {CALENDAR_AREAS.map((a) => {
                  const m = (maps.data ?? []).find((x) => x.area === a);
                  return (
                    <div key={a} className="form-grid">
                      <label>{AREA_LABEL[a]}<input name={`cal_${a}`} defaultValue={m?.gcal_calendar_id ?? ""} maxLength={300} placeholder="xxxx@group.calendar.google.com" /></label>
                      <label className="check"><input type="checkbox" name={`read_${a}`} defaultChecked={m?.read_enabled ?? true} /> Lettura</label>
                      <label className="check"><input type="checkbox" name={`write_${a}`} defaultChecked={m?.write_enabled ?? false} /> Scrittura</label>
                    </div>
                  );
                })}
                <SubmitButton>Salva calendari</SubmitButton>
              </form>
            </details>
          ) : <p className="meta">Per Google Calendar servono un client OAuth Google (GOOGLE_CLIENT_ID/SECRET), TOKEN_ENCRYPTION_KEY e APP_URL: vedi docs/SETUP.md.</p>}
        </Card>

        <Card title="Storico sincronizzazioni">
          {log.data?.length ? (
            <div className="table-wrap"><table><thead><tr><th>Quando</th><th>Servizio</th><th>Direzione</th><th>Esito</th><th>Dettaglio</th></tr></thead><tbody>
              {log.data.map((l) => <tr key={l.id}><td>{formatLocal(l.created_at, tz)}</td><td>{l.provider}</td><td>{l.direction === "pull" ? "ricezione" : "invio"}</td><td><Badge tone={l.outcome === "ok" ? "positive" : l.outcome === "conflict" ? "warning" : l.outcome === "error" ? "danger" : undefined}>{l.outcome}</Badge></td><td className="meta">{l.detail ?? ""}</td></tr>)}
            </tbody></table></div>
          ) : <Empty>Nessuna sincronizzazione eseguita.</Empty>}
        </Card>

        <Card title="Zona pericolosa">
          <form action={deleteAllData} className="row">
            <label className="grow">Elimina tutti i miei dati da Personal OS (irreversibile)<input name="confirm" placeholder='Scrivi "ELIMINA TUTTO"' maxLength={20} autoComplete="off" /></label>
            <SubmitButton className="btn danger">Elimina</SubmitButton>
          </form>
          <p className="meta">Non elimina le task in IronEdge ne&apos; gli eventi in Google Calendar. Prima esporta i dati se vuoi conservarli. <Link href="/sicurezza">Centro sicurezza</Link></p>
        </Card>
      </div>
    </>
  );
}
