import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SubmitButton } from "@/components/SubmitButton";
import { TaskForm } from "@/components/TaskForm";
import { Badge, Card, Empty, Flash, PageHeader, readSp, Stat, type SP } from "@/components/ui";
import { PRIORITY_LABEL, TASK_STATUS_LABEL } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import { addDays, dayBoundsUtc, formatDuration, formatLocal, weekStart } from "@/lib/time";
import { setTaskStatus } from "../../task/actions";
import { addMeeting, createProject, logTime, setProjectStatus, updateClient } from "../actions";

export const metadata = { title: "Cliente" };

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const sp = await readSp(searchParams);
  const id = z.uuid().safeParse((await params).id).data;
  if (!id) notFound();
  const { db, today, tz } = await requireUser();
  const { data: client } = await db.from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) notFound();
  const wsFrom = dayBoundsUtc(weekStart(today), tz).start.toISOString();
  const [projects, tasks, events, entries] = await Promise.all([
    db.from("projects").select("id, name, status, due_date").eq("client_id", id).order("status").order("due_date"),
    db.from("tasks").select("id, title, status, priority, due_at, estimated_minutes, category, recurrence, completed_at").eq("client_id", id).order("status").order("due_at", { nullsFirst: false }).limit(200),
    db.from("events").select("id, title, starts_at, ends_at, involves_others").eq("client_id", id).gte("starts_at", dayBoundsUtc(addDays(today, -30), tz).start.toISOString()).order("starts_at"),
    db.from("time_entries").select("id, minutes, started_at, note").eq("client_id", id).order("started_at", { ascending: false }).limit(50),
  ]);
  const back = `/marketing/${id}`;
  const open = (tasks.data ?? []).filter((t) => t.status === "todo" || t.status === "in_progress");
  const doneTasks = (tasks.data ?? []).filter((t) => t.status === "done");
  const content = open.filter((t) => /contenut|post|video|reel|copy/i.test(t.category ?? ""));
  const recurring = open.filter((t) => t.recurrence);
  const weekMin = (entries.data ?? []).filter((e) => e.started_at >= wsFrom).reduce((a, e) => a + e.minutes, 0);
  const totalMin = (entries.data ?? []).reduce((a, e) => a + e.minutes, 0);
  const nowIso = new Date().toISOString();
  const taskList = (list: typeof open) =>
    list.length ? (
      <ul className="list">{list.map((t) => (
        <li key={t.id}>
          <form action={setTaskStatus}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value={t.status === "done" ? "todo" : "done"} /><button className={`habit-cell ${t.status === "done" ? "on" : ""}`} style={{ width: 22, height: 22 }} type="submit" aria-label={`Completa ${t.title}`} /></form>
          <span className="grow truncate">{t.title}</span>
          {t.priority <= 2 ? <Badge tone="warning">{PRIORITY_LABEL[t.priority]}</Badge> : null}
          {t.due_at ? <span className={`meta ${t.due_at < nowIso ? "badge danger" : ""}`}>{new Date(t.due_at).toLocaleDateString("it-IT", { timeZone: tz, day: "numeric", month: "short" })}</span> : null}
          {t.estimated_minutes ? <span className="meta">{formatDuration(t.estimated_minutes)}</span> : null}
        </li>
      ))}</ul>
    ) : <p className="meta">Nessuna.</p>;
  return (
    <>
      <PageHeader title={client.name} sub={<Link href="/marketing">← Tutti i clienti</Link>} actions={<Badge tone={client.priority <= 2 ? "warning" : undefined}>Priorita&apos; {PRIORITY_LABEL[client.priority]}</Badge>} />
      <Flash sp={sp} />
      <div className="bento">
        <Card className="w-3"><Stat value={formatDuration(weekMin)} label={client.weekly_target_minutes ? `questa settimana su ${formatDuration(client.weekly_target_minutes)}` : "questa settimana"} /></Card>
        <Card className="w-3"><Stat value={open.length} label="task aperte" /></Card>
        <Card className="w-3"><Stat value={open.filter((t) => t.due_at && t.due_at < nowIso).length} label="scadute" /></Card>
        <Card className="w-3"><Stat value={formatDuration(totalMin)} label="tempo registrato (ultimi 50)" /></Card>

        <Card className="w-6" title="Task e scadenze">{taskList(open)}</Card>
        <Card className="w-6" title="Contenuti da produrre">{taskList(content)}<p className="meta">Task con categoria &quot;contenuti&quot;, &quot;post&quot;, &quot;video&quot;, &quot;reel&quot; o &quot;copy&quot;.</p></Card>

        <Card className="w-4" title="Progetti">
          {projects.data?.length ? (
            <ul className="list">{projects.data.map((p) => (
              <li key={p.id}>
                <span className="grow truncate">{p.name}</span>
                {p.due_date ? <span className="meta">{p.due_date}</span> : null}
                <form action={setProjectStatus}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value={p.status === "active" ? "done" : "active"} /><button className="btn ghost small" type="submit">{p.status === "active" ? "Concludi" : p.status}</button></form>
              </li>
            ))}</ul>
          ) : <Empty>Nessun progetto.</Empty>}
          <form action={createProject} className="row"><input type="hidden" name="client_id" value={id} /><input name="name" placeholder="Nuovo progetto" required maxLength={160} className="grow" style={{ width: "auto" }} /><input type="date" name="due" style={{ width: "auto" }} aria-label="Scadenza" /><SubmitButton className="btn small">Aggiungi</SubmitButton></form>
        </Card>
        <Card className="w-4" title="Riunioni e appuntamenti">
          {events.data?.length ? (
            <ul className="list">{events.data.map((e) => <li key={e.id}><span className="grow truncate">{e.title}</span><span className="meta">{formatLocal(e.starts_at, tz)}</span>{e.involves_others ? <Badge>con altri</Badge> : null}</li>)}</ul>
          ) : <Empty>Nessun appuntamento.</Empty>}
          <details><summary>Aggiungi</summary>
            <form action={addMeeting} className="stack" style={{ marginTop: 8 }}>
              <input type="hidden" name="client_id" value={id} />
              <label>Titolo<input name="title" required maxLength={200} /></label>
              <div className="form-grid"><label>Data<input type="date" name="date" required defaultValue={today} /></label><label>Inizio<input type="time" name="start" required /></label><label>Fine<input type="time" name="end" required /></label></div>
              <label className="check"><input type="checkbox" name="others" defaultChecked /> Con il cliente/altre persone</label>
              <SubmitButton className="btn small">Salva</SubmitButton>
            </form>
          </details>
        </Card>
        <Card className="w-4" title="Attivita' ricorrenti">{taskList(recurring)}</Card>

        <Card className="w-6" title="Nuova task per il cliente"><TaskForm back={back} area="marketing" clientId={id} /></Card>
        <Card className="w-6" title="Registra tempo">
          <form action={logTime} className="form-grid">
            <input type="hidden" name="client_id" value={id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="area" value="marketing" />
            <label>Minuti<input type="number" name="minutes" min={1} max={1440} required /></label>
            <label>Data<input type="date" name="date" defaultValue={today} /></label>
            <label>Ora<input type="time" name="time" defaultValue="09:00" /></label>
            <label>Nota<input name="note" maxLength={500} /></label>
            <SubmitButton>Registra</SubmitButton>
          </form>
          <h3>Storico</h3>
          {entries.data?.length || doneTasks.length ? (
            <ul className="list">
              {(entries.data ?? []).slice(0, 10).map((e) => <li key={e.id}><span className="grow truncate">{e.note ?? "Lavoro"}</span><span className="meta">{formatDuration(e.minutes)} · {formatLocal(e.started_at, tz, false)}</span></li>)}
              {doneTasks.slice(0, 10).map((t) => <li key={t.id}><span className="grow truncate">✓ {t.title}</span><span className="meta">{TASK_STATUS_LABEL[t.status]}{t.completed_at ? ` · ${formatLocal(t.completed_at, tz, false)}` : ""}</span></li>)}
            </ul>
          ) : <Empty>Nessuno storico.</Empty>}
        </Card>

        <Card className="w-12" title="Scheda cliente">
          <form action={updateClient} className="stack">
            <input type="hidden" name="id" value={id} />
            <div className="form-grid">
              <label>Priorita&apos;<select name="priority" defaultValue={String(client.priority)}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
              <label>Ore/settimana<input type="number" name="weekly_hours" min={0} max={100} step={0.5} defaultValue={client.weekly_target_minutes ? client.weekly_target_minutes / 60 : ""} /></label>
              <label className="check"><input type="checkbox" name="active" defaultChecked={client.active} /> Attivo</label>
            </div>
            <label>Note<textarea name="notes" maxLength={4000} defaultValue={client.contact_notes ?? ""} /></label>
            <SubmitButton className="btn">Salva scheda</SubmitButton>
          </form>
        </Card>
      </div>
    </>
  );
}
