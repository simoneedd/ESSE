import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Card, Empty, Flash, PageHeader, readSp, type SP } from "@/components/ui";
import { TRADING_KIND_LABEL } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import { addDays, dayBoundsUtc, formatLocal, formatTime } from "@/lib/time";
import { setTaskStatus } from "../task/actions";
import { addTradingSession, deleteTradingSession, setTradingStatus } from "./actions";

export const metadata = { title: "Trading" };

export default async function TradingPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz } = await requireUser();
  const from = dayBoundsUtc(addDays(today, -7), tz).start.toISOString();
  const to = dayBoundsUtc(addDays(today, 21), tz).end.toISOString();
  const [sessions, ie] = await Promise.all([
    db.from("trading_sessions").select("id, kind, title, starts_at, ends_at, status, fixed, instrument").gte("starts_at", from).lt("starts_at", to).order("starts_at"),
    db.from("tasks").select("id, title, due_at, status, external_url, category").eq("source", "ironedge").in("status", ["todo", "in_progress"]).order("due_at").limit(30),
  ]);
  const nowIso = new Date().toISOString();
  const upcoming = (sessions.data ?? []).filter((s) => s.ends_at >= nowIso);
  const past = (sessions.data ?? []).filter((s) => s.ends_at < nowIso).reverse();
  return (
    <>
      <PageHeader title="Trading" sub="Pianificazione di sessioni, analisi, appuntamenti macro, live e attivita' IronEdge." />
      <Flash sp={sp} />
      <p className="notice" style={{ marginBottom: 16 }}>Personal OS organizza il tempo dedicato al trading: non si collega a broker, non esegue ordini e non fornisce segnali o raccomandazioni di investimento.</p>
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <div className="stack">
          <Card title="In programma">
            {upcoming.length ? (
              <ul className="list">{upcoming.map((s) => (
                <li key={s.id} className="area-trading">
                  <span className="area-dot" />
                  <span className="grow stack-s"><span className="truncate">{s.title}</span><span className="meta">{formatLocal(s.starts_at, tz)}–{formatTime(s.ends_at, tz)} · {TRADING_KIND_LABEL[s.kind]}{s.instrument ? ` · ${s.instrument}` : ""}</span></span>
                  {s.fixed ? <Badge>fisso</Badge> : <Badge tone="accent">flessibile</Badge>}
                  <form action={setTradingStatus}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="status" value="done" /><button className="btn small" type="submit">Fatto</button></form>
                  <form action={deleteTradingSession}><input type="hidden" name="id" value={s.id} /><button className="btn ghost small" type="submit" aria-label={`Elimina ${s.title}`}>×</button></form>
                </li>
              ))}</ul>
            ) : <Empty>Nessuna sessione in programma.</Empty>}
          </Card>
          <Card title="Task sincronizzate da IronEdge Growth OS">
            {ie.data?.length ? (
              <ul className="list">{ie.data.map((t) => (
                <li key={t.id}>
                  <form action={setTaskStatus}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="back" value="/trading" /><input type="hidden" name="status" value="done" /><button className="habit-cell" style={{ width: 22, height: 22 }} type="submit" aria-label={`Completa ${t.title}`} /></form>
                  <span className="grow truncate">{t.title}</span>
                  {t.due_at ? <span className={`meta ${t.due_at < nowIso ? "badge danger" : ""}`}>{new Date(t.due_at).toLocaleDateString("it-IT", { timeZone: tz, day: "numeric", month: "short" })}</span> : null}
                  {t.external_url ? <a className="meta" href={t.external_url} target="_blank" rel="noopener noreferrer">Apri</a> : null}
                </li>
              ))}</ul>
            ) : <Empty>Nessuna task IronEdge aperta (o integrazione non ancora configurata).</Empty>}
            <p className="meta">Completarle qui aggiorna lo stato nel gestionale IronEdge alla sincronizzazione successiva.</p>
          </Card>
          <Card title="Ultimi 7 giorni">
            {past.length ? <ul className="list">{past.map((s) => <li key={s.id}><span className="grow truncate">{s.title}</span><span className="meta">{formatLocal(s.starts_at, tz)} · {s.status === "done" ? "svolta" : s.status === "skipped" ? "saltata" : "non registrata"}</span></li>)}</ul> : <p className="meta">Nessuna.</p>}
          </Card>
        </div>
        <Card title="Nuova attivita'">
          <form action={addTradingSession} className="stack">
            <label>Tipo<select name="kind" defaultValue="operative_session">{Object.entries(TRADING_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label>Titolo<input name="title" required maxLength={200} placeholder="es. Sessione Londra, CPI USA, Live TikTok" /></label>
            <div className="form-grid">
              <label>Data<input type="date" name="date" required defaultValue={today} /></label>
              <label>Inizio<input type="time" name="start" required /></label>
              <label>Fine<input type="time" name="end" required /></label>
              <label>Ripeti (settimane)<input type="number" name="repeat_weeks" min={1} max={12} defaultValue={1} /></label>
            </div>
            <label>Strumento<input name="instrument" maxLength={40} placeholder="es. XAUUSD" /></label>
            <label>Note<textarea name="notes" maxLength={4000} /></label>
            <label className="check"><input type="checkbox" name="fixed" /> Orario fisso (macro, webinar, live e lezioni lo sono gia&apos;)</label>
            <SubmitButton>Aggiungi</SubmitButton>
          </form>
        </Card>
      </div>
    </>
  );
}
