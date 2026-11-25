import Link from "next/link";
import { AreaTag, Badge, Card, Empty, Flash, PageHeader, readSp, type SP } from "@/components/ui";
import { AREA_LABEL, isLifeArea, LIFE_AREAS, PRIORITY_LABEL, TASK_STATUS_LABEL, type LifeArea } from "@/lib/domain";
import { canAutoReschedule } from "@/lib/plan-service";
import { requireUser } from "@/lib/session";
import { formatDuration } from "@/lib/time";
import { TaskForm } from "@/components/TaskForm";
import { deleteTask, setTaskAutonomy, setTaskStatus } from "./actions";

export const metadata = { title: "Task" };

export default async function TasksPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, profile, tz } = await requireUser();
  const area = isLifeArea(sp.area) ? sp.area : null;
  const status = sp.status === "done" ? "done" : "open";
  let q = db.from("tasks").select("id, title, area, priority, due_at, estimated_minutes, status, source, external_url, auto_reschedule, client:clients(name), postponed_count, depends_on").order("due_at", { ascending: true, nullsFirst: false }).limit(300);
  q = status === "open" ? q.in("status", ["todo", "in_progress"]) : q.eq("status", "done");
  if (area) q = q.eq("area", area);
  const [{ data: tasks }, { data: clients }] = await Promise.all([q, db.from("clients").select("id, name").eq("active", true).order("name")]);
  const back = `/task?${new URLSearchParams({ ...(area ? { area } : {}), status }).toString()}`;
  const nowIso = new Date().toISOString();
  return (
    <>
      <PageHeader title="Task" sub="Attivita' personali e di lavoro, comprese quelle sincronizzate da IronEdge." />
      <Flash sp={sp} />
      <nav className="row" aria-label="Filtri" style={{ marginBottom: 14 }}>
        <Link className="btn small" aria-current={!area ? "page" : undefined} href={`/task?status=${status}`}>Tutte</Link>
        {LIFE_AREAS.map((a) => <Link key={a} className="btn small" aria-current={area === a ? "page" : undefined} href={`/task?area=${a}&status=${status}`}>{AREA_LABEL[a]}</Link>)}
        <span className="grow" />
        <Link className="btn small" href={`/task?${area ? `area=${area}&` : ""}status=${status === "open" ? "done" : "open"}`}>{status === "open" ? "Mostra completate" : "Mostra aperte"}</Link>
      </nav>
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <Card title={`${status === "open" ? "Aperte" : "Completate"} (${tasks?.length ?? 0})`}>
          {tasks?.length ? (
            <ul className="list">
              {tasks.map((t) => {
                const auto = canAutoReschedule({ area: t.area as LifeArea, auto_reschedule: t.auto_reschedule }, profile.auto_reschedule_areas);
                return (
                  <li key={t.id} style={{ alignItems: "flex-start" }}>
                    <form action={setTaskStatus}>
                      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value={t.status === "done" ? "todo" : "done"} />
                      <button className={`habit-cell ${t.status === "done" ? "on" : ""}`} style={{ width: 22, height: 22 }} type="submit" aria-label={t.status === "done" ? `Riapri ${t.title}` : `Completa ${t.title}`} />
                    </form>
                    <div className="grow stack-s">
                      <span>{t.title}</span>
                      <div className="row meta">
                        <AreaTag area={t.area as LifeArea} />
                        {t.priority <= 2 ? <Badge tone={t.priority === 1 ? "danger" : "warning"}>{PRIORITY_LABEL[t.priority]}</Badge> : null}
                        {t.due_at ? <span className={t.due_at < nowIso && t.status !== "done" ? "badge danger" : ""}>{new Date(t.due_at).toLocaleDateString("it-IT", { timeZone: tz, day: "numeric", month: "short" })}</span> : null}
                        {t.estimated_minutes ? <span>{formatDuration(t.estimated_minutes)}</span> : null}
                        {(t as unknown as { client: { name: string } | null }).client ? <span>{(t as unknown as { client: { name: string } }).client.name}</span> : null}
                        {t.postponed_count ? <span>rimandata {t.postponed_count}×</span> : null}
                        {t.depends_on?.length ? <span>dipende da {t.depends_on.length}</span> : null}
                        {t.source === "ironedge" ? <Badge tone="accent">IronEdge</Badge> : null}
                        {t.external_url ? <a href={t.external_url} target="_blank" rel="noopener noreferrer">Apri originale</a> : null}
                        <span>{TASK_STATUS_LABEL[t.status]}</span>
                      </div>
                    </div>
                    <form action={setTaskAutonomy} className="row">
                      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="back" value={back} />
                      <input type="hidden" name="auto" value={auto ? "no" : "yes"} />
                      <button className="btn ghost small" type="submit" title="Riprogrammazione autonoma">{auto ? "Auto" : "Chiedi"}</button>
                    </form>
                    {t.source === "local" ? (
                      <form action={deleteTask}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="back" value={back} /><button className="btn ghost small" type="submit" aria-label={`Elimina ${t.title}`}>×</button></form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>Nessuna task.</Empty>
          )}
        </Card>
        <Card title="Nuova task">
          <TaskForm back={back} area={area && area !== "ironedge" ? area : undefined} clients={clients ?? []} />
          <p className="meta">&quot;Auto&quot; = l&apos;assistente puo&apos; spostarla da solo se non entra; &quot;Chiedi&quot; = serve la tua approvazione. Le task IronEdge si modificano nel gestionale; qui puoi completarle.</p>
        </Card>
      </div>
    </>
  );
}
