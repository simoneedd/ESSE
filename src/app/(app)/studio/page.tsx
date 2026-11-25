import { SubmitButton } from "@/components/SubmitButton";
import { Card, Empty, Flash, PageHeader, Progress, readSp, Stat, type SP } from "@/components/ui";
import { STUDY_KIND_LABEL } from "@/lib/domain";
import { focusPlan, progressPercent } from "@/lib/planning";
import { requireUser } from "@/lib/session";
import { dayBoundsUtc, formatDuration, formatLocal, weekStart } from "@/lib/time";
import { addNote, addStudyItem, logStudySession, reviewNote } from "./actions";

export const metadata = { title: "Studio" };

export default async function StudyPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz } = await requireUser();
  const wsFrom = dayBoundsUtc(weekStart(today), tz).start.toISOString();
  const [items, sessions, reviews] = await Promise.all([
    db.from("study_items").select("id, kind, title, author, goal, total_units, done_units, weekly_target_minutes, due_date").eq("active", true).order("due_date", { nullsFirst: false }),
    db.from("study_sessions").select("id, item_id, started_at, focus_minutes, units_done").order("started_at", { ascending: false }).limit(60),
    db.from("study_notes").select("id, title, next_review_on, review_stage").lte("next_review_on", today).order("next_review_on").limit(20),
  ]);
  const week = (sessions.data ?? []).filter((s) => s.started_at >= wsFrom);
  const weekMin = week.reduce((a, s) => a + s.focus_minutes, 0);
  const total = (sessions.data ?? []).reduce((a, s) => a + s.focus_minutes, 0);
  const plan = focusPlan(60);
  return (
    <>
      <PageHeader title="Studio" sub="Corsi, materie e libri con sessioni di concentrazione e ripassi programmati." />
      <Flash sp={sp} />
      <div className="bento">
        <Card className="w-3"><Stat value={formatDuration(weekMin)} label="studiate questa settimana" /></Card>
        <Card className="w-3"><Stat value={formatDuration(total)} label="ultime 60 sessioni" /></Card>
        <Card className="w-3"><Stat value={reviews.data?.length ?? 0} label="ripassi in scadenza" /></Card>
        <Card className="w-3"><Stat value={items.data?.length ?? 0} label="percorsi attivi" /></Card>

        <Card className="w-8" title="Percorsi">
          {items.data?.length ? (
            <ul className="list">{items.data.map((i) => {
              const spent = week.filter((s) => s.item_id === i.id).reduce((a, s) => a + s.focus_minutes, 0);
              return (
                <li key={i.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <div className="row-between"><b>{i.title}</b><span className="meta">{STUDY_KIND_LABEL[i.kind]}{i.author ? ` · ${i.author}` : ""}{i.due_date ? ` · entro ${i.due_date}` : ""}</span></div>
                  <Progress value={progressPercent(i.done_units, i.total_units)} label={i.total_units ? `${i.done_units}/${i.total_units}` : "Avanzamento"} />
                  {i.weekly_target_minutes ? <span className="meta">Settimana: {formatDuration(spent)} su {formatDuration(i.weekly_target_minutes)}</span> : null}
                  {i.goal ? <span className="meta">Obiettivo: {i.goal}</span> : null}
                </li>
              );
            })}</ul>
          ) : <Empty>Nessun corso, materia o libro.</Empty>}
        </Card>
        <Card className="w-4" title="Ripassi di oggi">
          {reviews.data?.length ? (
            <ul className="list">{reviews.data.map((n) => (
              <li key={n.id}>
                <span className="grow truncate">{n.title}</span>
                <form action={reviewNote}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="remembered" value="1" /><button className="btn small" type="submit">Ricordato</button></form>
                <form action={reviewNote}><input type="hidden" name="id" value={n.id} /><input type="hidden" name="remembered" value="0" /><button className="btn ghost small" type="submit">Da rivedere</button></form>
              </li>
            ))}</ul>
          ) : <Empty>Nessun ripasso in scadenza.</Empty>}
          <p className="meta">Intervalli: 1, 3, 7, 14, 30, 60 giorni.</p>
        </Card>

        <Card className="w-4" title="Registra sessione">
          <form action={logStudySession} className="stack">
            <label>Percorso<select name="item_id" defaultValue=""><option value="">—</option>{(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
            <div className="form-grid">
              <label>Concentrazione (min)<input type="number" name="focus" min={1} max={600} required defaultValue={50} /></label>
              <label>Pause (min)<input type="number" name="breaks" min={0} max={300} defaultValue={10} /></label>
              <label>Unita&apos; completate<input type="number" name="units" min={0} max={10000} /></label>
              <label>Data<input type="date" name="date" defaultValue={today} /></label>
            </div>
            <SubmitButton>Registra</SubmitButton>
          </form>
        </Card>
        <Card className="w-4" title="Sessione di concentrazione (60 min)">
          <ol className="list">{plan.parts.map((p, i) => <li key={i}><span className="grow">{p.kind === "focus" ? "Concentrazione" : "Pausa"}</span><span className="meta">{p.minutes} min</span></li>)}</ol>
          <p className="meta">Metodo a cicli 25/5 con pausa lunga ogni 4 cicli. Per bloccare tempo nel piano: chiedi all&apos;assistente &quot;trovami un&apos;ora al giorno per studiare&quot;.</p>
        </Card>
        <Card className="w-4" title="Nuovo appunto">
          <form action={addNote} className="stack">
            <label>Percorso<select name="item_id" defaultValue=""><option value="">—</option>{(items.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
            <label>Titolo<input name="title" required maxLength={200} /></label>
            <label>Testo<textarea name="body" maxLength={20000} /></label>
            <SubmitButton>Salva appunto</SubmitButton>
          </form>
        </Card>

        <Card className="w-6" title="Nuovo corso, materia o libro">
          <form action={addStudyItem} className="stack">
            <div className="form-grid">
              <label>Tipo<select name="kind" defaultValue="course">{Object.entries(STUDY_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Unita&apos; totali<input type="number" name="total_units" min={1} max={100000} placeholder="lezioni/pagine" /></label>
              <label>Ore/settimana<input type="number" name="weekly_hours" min={0} max={60} step={0.5} /></label>
              <label>Scadenza<input type="date" name="due" /></label>
            </div>
            <label>Titolo<input name="title" required maxLength={200} /></label>
            <label>Autore/ente<input name="author" maxLength={120} /></label>
            <label>Obiettivo<input name="goal" maxLength={500} /></label>
            <SubmitButton>Aggiungi</SubmitButton>
          </form>
        </Card>
        <Card className="w-6" title="Sessioni recenti">
          {sessions.data?.length ? <ul className="list">{sessions.data.slice(0, 12).map((s) => <li key={s.id}><span className="grow">{(items.data ?? []).find((i) => i.id === s.item_id)?.title ?? "Studio"}</span><span className="meta">{formatDuration(s.focus_minutes)} · {formatLocal(s.started_at, tz, false)}</span></li>)}</ul> : <Empty>Nessuna sessione registrata.</Empty>}
        </Card>
      </div>
    </>
  );
}
