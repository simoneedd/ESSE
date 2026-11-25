import { SubmitButton } from "@/components/SubmitButton";
import { Card, Empty, Flash, PageHeader, readSp, type SP } from "@/components/ui";
import { AREA_LABEL, LIFE_AREAS } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import { addDays } from "@/lib/time";
import { addHabit, archiveHabit, toggleHabit } from "./actions";

export const metadata = { title: "Abitudini" };

export default async function HabitsPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today } = await requireUser();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const [habits, logs] = await Promise.all([
    db.from("habits").select("id, name, area, target_per_week").eq("active", true).order("created_at"),
    db.from("habit_logs").select("habit_id, log_date").gte("log_date", days[0]),
  ]);
  const done = new Set((logs.data ?? []).map((l) => `${l.habit_id}:${l.log_date}`));
  return (
    <>
      <PageHeader title="Abitudini" sub="Ultimi 7 giorni. Tocca una casella per segnarla." />
      <Flash sp={sp} />
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <Card>
          {habits.data?.length ? (
            <div className="habit-grid" role="grid" aria-label="Tracker abitudini">
              <span />
              {days.map((d) => <span key={d} className="meta" style={{ textAlign: "center" }}>{new Date(`${d}T12:00:00Z`).toLocaleDateString("it-IT", { weekday: "narrow", timeZone: "UTC" })}</span>)}
              {habits.data.map((h) => {
                const count = days.filter((d) => done.has(`${h.id}:${d}`)).length;
                return [
                  <span key={`${h.id}-n`} className={`row area-${h.area}`}><span className="area-dot" /><span className="truncate grow">{h.name}</span><span className="meta">{count}/{h.target_per_week}</span></span>,
                  ...days.map((d) => (
                    <form key={`${h.id}-${d}`} action={toggleHabit} style={{ display: "grid", placeItems: "center" }}>
                      <input type="hidden" name="habit_id" value={h.id} /><input type="hidden" name="date" value={d} /><input type="hidden" name="back" value="/abitudini" />
                      <button type="submit" className={`habit-cell ${done.has(`${h.id}:${d}`) ? "on" : ""}`} aria-pressed={done.has(`${h.id}:${d}`)} aria-label={`${h.name} ${d}`} />
                    </form>
                  )),
                ];
              })}
            </div>
          ) : <Empty>Nessuna abitudine.</Empty>}
        </Card>
        <div className="stack">
          <Card title="Nuova abitudine">
            <form action={addHabit} className="stack">
              <label>Nome<input name="name" required maxLength={80} placeholder="es. 10 minuti di lettura" /></label>
              <div className="form-grid">
                <label>Area<select name="area" defaultValue="personal">{LIFE_AREAS.map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}</select></label>
                <label>Volte/settimana<input type="number" name="target_per_week" min={1} max={7} defaultValue={7} /></label>
              </div>
              <SubmitButton>Aggiungi</SubmitButton>
            </form>
          </Card>
          {habits.data?.length ? (
            <Card title="Archivia">
              <ul className="list">{habits.data.map((h) => <li key={h.id}><span className="grow">{h.name}</span><form action={archiveHabit}><input type="hidden" name="id" value={h.id} /><button className="btn ghost small" type="submit">Archivia</button></form></li>)}</ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
