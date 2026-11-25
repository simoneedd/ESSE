import Link from "next/link";
import { z } from "zod";
import { SubmitButton } from "@/components/SubmitButton";
import { Timeline, type TimelineBlock } from "@/components/Timeline";
import { AreaTag, Badge, Card, Empty, Flash, PageHeader, readSp, type SP } from "@/components/ui";
import { AREA_LABEL, LIFE_AREAS, type LifeArea } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import { addDays, dayBoundsUtc, formatDuration, formatTime } from "@/lib/time";
import { addEvent, decideProposal, deleteEvent, planDayAction, setBlockStatus } from "./actions";

export const metadata = { title: "Agenda di oggi" };

export default async function TodayPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz } = await requireUser();
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(sp.d).data ?? today;
  const { start, end } = dayBoundsUtc(date, tz);
  const [blocks, proposals, events] = await Promise.all([
    db.from("schedule_blocks").select("id, starts_at, ends_at, title, area, kind, flexibility, status, task_id").eq("plan_date", date).order("starts_at"),
    db.from("plan_proposals").select("id, kind, summary, reason, created_by, created_at").eq("status", "pending").order("created_at", { ascending: false }),
    db.from("events").select("id, title, area, starts_at, ends_at, involves_others, is_external, origin").lt("starts_at", end.toISOString()).gt("ends_at", start.toISOString()).order("starts_at"),
  ]);
  const tl = (blocks.data ?? []) as TimelineBlock[];
  const back = `/oggi?d=${date}`;
  const work = tl.filter((b) => ["task", "workout", "study", "trading"].includes(b.kind));
  const doneCount = work.filter((b) => b.status === "done").length;
  const label = date === today ? "Oggi" : date === addDays(today, 1) ? "Domani" : date === addDays(today, -1) ? "Ieri" : date;

  return (
    <>
      <PageHeader
        title={`Agenda · ${label}`}
        sub={new Intl.DateTimeFormat("it-IT", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(start)}
        actions={
          <>
            <Link className="btn small" href={`/oggi?d=${addDays(date, -1)}`} aria-label="Giorno precedente">‹</Link>
            <Link className="btn small" href="/oggi">Oggi</Link>
            <Link className="btn small" href={`/oggi?d=${addDays(date, 1)}`} aria-label="Giorno successivo">›</Link>
            <form action={planDayAction}><input type="hidden" name="date" value={date} /><SubmitButton>{tl.length ? "Ripianifica" : "Genera piano"}</SubmitButton></form>
          </>
        }
      />
      <Flash sp={sp} />
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <Card title="Timeline" action={work.length ? <Badge>{doneCount}/{work.length} completate</Badge> : null}>
          {tl.length ? (
            <Timeline
              blocks={tl}
              tz={tz}
              now={date === today ? new Date() : undefined}
              actions={(b) =>
                ["task", "workout", "study", "trading"].includes(b.kind) ? (
                  <div className="row">
                    {b.status === "planned" ? (
                      <>
                        <form action={setBlockStatus}>
                          <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="done" />
                          {b.task_id ? <input type="hidden" name="complete_task" value="1" /> : null}
                          <button className="btn small" type="submit" aria-label={`Fatto: ${b.title}`}>Fatto</button>
                        </form>
                        <form action={setBlockStatus}>
                          <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="partial" />
                          <button className="btn ghost small" type="submit" aria-label={`Parziale: ${b.title}`}>Parziale</button>
                        </form>
                        <form action={setBlockStatus}>
                          <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="skipped" />
                          <button className="btn ghost small" type="submit" aria-label={`Non svolto: ${b.title}`}>Salta</button>
                        </form>
                      </>
                    ) : (
                      <form action={setBlockStatus}>
                        <input type="hidden" name="id" value={b.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="status" value="planned" />
                        <button className="btn ghost small" type="submit">Annulla</button>
                      </form>
                    )}
                  </div>
                ) : null
              }
            />
          ) : (
            <Empty>Nessun piano per questa giornata. Premi &quot;Genera piano&quot;: il sonno, i pasti e un margine per gli imprevisti vengono riservati prima delle attivita&apos;.</Empty>
          )}
        </Card>

        <div className="stack">
          <Card title="Proposte da approvare" className={proposals.data?.length ? "accent" : ""}>
            <div id="proposte" />
            {proposals.data?.length ? (
              <ul className="list">
                {proposals.data.map((p) => (
                  <li key={p.id} style={{ alignItems: "flex-start", flexDirection: "column" }}>
                    <span>{p.summary}</span>
                    {p.reason ? <span className="meta">{p.reason}</span> : null}
                    <div className="row">
                      <form action={decideProposal}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="decision" value="approve" /><button className="btn primary small" type="submit">Approva</button></form>
                      <form action={decideProposal}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="decision" value="reject" /><button className="btn small" type="submit">Rifiuta</button></form>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="meta">Nessuna proposta: le modifiche a impegni fissi e riunioni passano sempre da qui.</p>
            )}
          </Card>

          <Card title="Impegni fissi">
            {events.data?.length ? (
              <ul className="list">
                {events.data.map((e) => (
                  <li key={e.id} className={`area-${e.area}`}>
                    <span className="area-dot" />
                    <span className="grow stack-s"><span className="truncate">{e.title}</span><span className="meta">{formatTime(e.starts_at, tz)}–{formatTime(e.ends_at, tz)}{e.involves_others ? " · con altre persone" : ""}{e.origin === "google" ? " · Google" : ""}</span></span>
                    {e.origin !== "google" ? (
                      <form action={deleteEvent}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="back" value={back} />{e.involves_others ? <input type="hidden" name="confirm" value="1" /> : null}<button className="btn ghost small" type="submit" aria-label={`Elimina ${e.title}`}>×</button></form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="meta">Nessun impegno fisso.</p>
            )}
            <details>
              <summary>Aggiungi impegno</summary>
              <form action={addEvent} className="stack" style={{ marginTop: 10 }}>
                <input type="hidden" name="date" value={date} />
                <label>Titolo<input name="title" required maxLength={200} /></label>
                <div className="form-grid">
                  <label>Inizio<input type="time" name="start" required /></label>
                  <label>Fine<input type="time" name="end" required /></label>
                  <label>Area<select name="area" defaultValue="personal">{LIFE_AREAS.map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}</select></label>
                  <label>Spostamento (min)<input type="number" name="travel" min={0} max={240} defaultValue={0} /></label>
                </div>
                <label>Luogo<input name="location" maxLength={200} /></label>
                <label className="check"><input type="checkbox" name="involves_others" /> Con altre persone</label>
                <label className="check"><input type="checkbox" name="is_external" /> Impegno esterno</label>
                <label className="check"><input type="checkbox" name="replan" defaultChecked /> Ripianifica le attivita&apos; flessibili</label>
                <SubmitButton>Aggiungi</SubmitButton>
              </form>
            </details>
          </Card>

          <Card title="Riepilogo">
            {(() => {
              const by = new Map<LifeArea, number>();
              for (const b of tl) if (!["sleep", "wind_down", "break", "buffer", "travel"].includes(b.kind)) by.set(b.area, (by.get(b.area) ?? 0) + (Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60000);
              return by.size ? (
                <ul className="list">{[...by.entries()].map(([a, m]) => <li key={a}><AreaTag area={a} /><span className="grow" /><span className="meta">{formatDuration(m)}</span></li>)}</ul>
              ) : (
                <p className="meta">Nessun dato.</p>
              );
            })()}
          </Card>
        </div>
      </div>
    </>
  );
}
