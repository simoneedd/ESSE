import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Card, Empty, Flash, PageHeader, readSp, Sparkline, Stat, type SP } from "@/components/ui";
import { requireUser } from "@/lib/session";
import { addDays, dayBoundsUtc, formatLocal, weekStart } from "@/lib/time";
import { addExercise, addTemplate, logWorkout, planWorkout, removeExercise } from "./actions";

export const metadata = { title: "Palestra" };

export default async function GymPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz } = await requireUser();
  const ws = weekStart(today);
  const [templates, sessions, sets] = await Promise.all([
    db.from("workout_templates").select("id, name, focus, estimated_minutes, template_exercises(id, position, exercise, sets, reps, load_kg, rest_seconds)").eq("active", true).order("created_at"),
    db.from("workout_sessions").select("id, planned_for, performed_at, status, duration_minutes, perceived_effort, template:workout_templates(name)").gte("planned_for", dayBoundsUtc(addDays(today, -60), tz).start.toISOString()).order("planned_for", { ascending: false }),
    db.from("session_sets").select("exercise, load_kg, reps, created_at").not("load_kg", "is", null).order("created_at").limit(2000),
  ]);
  const weekFrom = dayBoundsUtc(ws, tz).start.toISOString();
  const weekTo = dayBoundsUtc(addDays(ws, 6), tz).end.toISOString();
  const thisWeek = (sessions.data ?? []).filter((s) => s.planned_for && s.planned_for >= weekFrom && s.planned_for < weekTo);
  const upcoming = (sessions.data ?? []).filter((s) => s.status === "planned" && s.planned_for! >= dayBoundsUtc(today, tz).start.toISOString()).reverse();
  const history = (sessions.data ?? []).filter((s) => s.status === "done").slice(0, 15);
  // progressi: carico massimo per esercizio per sessione (solo dati registrati)
  const byEx = new Map<string, number[]>();
  for (const s of sets.data ?? []) {
    const arr = byEx.get(s.exercise) ?? [];
    arr.push(Number(s.load_kg));
    byEx.set(s.exercise, arr);
  }
  const progress = [...byEx.entries()].filter(([, v]) => v.length >= 2).slice(0, 6);
  const tplName = (s: { template: unknown }) => (s.template as { name: string } | null)?.name ?? "Allenamento";
  return (
    <>
      <PageHeader title="Palestra" sub="Schede, calendario allenamenti, storico e progressi." />
      <Flash sp={sp} />
      <div className="bento">
        <Card className="w-3"><Stat value={thisWeek.filter((s) => s.status === "done").length} label="svolti questa settimana" /></Card>
        <Card className="w-3"><Stat value={thisWeek.filter((s) => s.status === "planned").length} label="ancora pianificati" /></Card>
        <Card className="w-3"><Stat value={thisWeek.filter((s) => s.status === "rest_day").length} label="giorni di riposo" /></Card>
        <Card className="w-3"><Stat value={history.length} label="allenamenti (60 giorni)" /></Card>

        <Card className="w-6" title="Prossimi allenamenti">
          {upcoming.length ? <ul className="list">{upcoming.map((s) => <li key={s.id}><span className="area-dot area-gym" /><span className="grow">{tplName(s)}</span><span className="meta">{formatLocal(s.planned_for!, tz)}</span></li>)}</ul> : <Empty>Nessun allenamento pianificato. Chiedi all&apos;assistente: &quot;inserisci quattro allenamenti questa settimana&quot;.</Empty>}
          <details><summary>Pianifica manualmente</summary>
            <form action={planWorkout} className="form-grid" style={{ marginTop: 8 }}>
              <label>Scheda<select name="template_id">{(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
              <label>Data<input type="date" name="date" required defaultValue={today} /></label>
              <label>Ora indicativa<input type="time" name="time" defaultValue="18:00" /></label>
              <label className="check"><input type="checkbox" name="rest_day" /> Giorno di riposo</label>
              <SubmitButton className="btn">Salva</SubmitButton>
            </form>
          </details>
          <p className="meta">L&apos;orario esatto viene scelto nel piano giornaliero in base a lavoro e recupero.</p>
        </Card>
        <Card className="w-6" title="Registra allenamento svolto">
          <form action={logWorkout} className="stack">
            <div className="form-grid">
              <label>Scheda<select name="template_id" defaultValue=""><option value="">—</option>{(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
              <label>Pianificato<select name="session_id" defaultValue=""><option value="">Nuovo</option>{upcoming.map((s) => <option key={s.id} value={s.id}>{tplName(s)} · {formatLocal(s.planned_for!, tz, false)}</option>)}</select></label>
              <label>Data<input type="date" name="date" defaultValue={today} /></label>
              <label>Durata (min)<input type="number" name="duration" min={1} max={400} /></label>
              <label>Fatica (1-10)<input type="number" name="rpe" min={1} max={10} /></label>
            </div>
            <label>Serie (una riga per esercizio)<textarea name="sets" placeholder={"Panca piana 4x8@60\nTrazioni 3x10"} maxLength={4000} /></label>
            <label>Note<input name="note" maxLength={500} /></label>
            <SubmitButton>Registra</SubmitButton>
          </form>
        </Card>

        {(templates.data ?? []).map((t) => (
          <Card key={t.id} className="w-6" title={t.name} action={<Badge>{t.estimated_minutes} min</Badge>}>
            {t.focus ? <p className="meta">{t.focus}</p> : null}
            {t.template_exercises?.length ? (
              <div className="table-wrap"><table><thead><tr><th>Esercizio</th><th>Serie</th><th>Rip.</th><th>Carico</th><th>Recupero</th><th /></tr></thead><tbody>
                {[...t.template_exercises].sort((a, b) => a.position - b.position).map((e) => (
                  <tr key={e.id}><td>{e.exercise}</td><td>{e.sets}</td><td>{e.reps}</td><td>{e.load_kg != null ? `${e.load_kg} kg` : "—"}</td><td>{e.rest_seconds != null ? `${e.rest_seconds}s` : "—"}</td>
                    <td><form action={removeExercise}><input type="hidden" name="id" value={e.id} /><button className="btn ghost small" type="submit" aria-label={`Rimuovi ${e.exercise}`}>×</button></form></td></tr>
                ))}
              </tbody></table></div>
            ) : <Empty>Nessun esercizio.</Empty>}
            <form action={addExercise} className="form-grid">
              <input type="hidden" name="template_id" value={t.id} />
              <label>Esercizio<input name="exercise" required maxLength={120} /></label>
              <label>Serie<input type="number" name="sets" min={1} max={20} defaultValue={3} /></label>
              <label>Rip.<input name="reps" maxLength={20} defaultValue="10" /></label>
              <label>Carico kg<input type="number" name="load" min={0} max={1000} step={0.5} /></label>
              <label>Recupero s<input type="number" name="rest" min={0} max={900} step={15} defaultValue={90} /></label>
              <SubmitButton className="btn small">Aggiungi</SubmitButton>
            </form>
          </Card>
        ))}
        <Card className="w-6" title="Nuova scheda">
          <form action={addTemplate} className="stack">
            <label>Nome<input name="name" required maxLength={120} placeholder="es. Upper A" /></label>
            <div className="form-grid"><label>Focus<input name="focus" maxLength={120} /></label><label>Durata (min)<input type="number" name="minutes" min={10} max={300} defaultValue={60} /></label></div>
            <SubmitButton>Crea scheda</SubmitButton>
          </form>
          <p className="meta">Le schede sono tue o del tuo coach: Personal OS non genera programmi di allenamento.</p>
        </Card>

        <Card className="w-6" title="Progressi (carico massimo registrato)">
          {progress.length ? progress.map(([ex, vals]) => <div key={ex} className="stack-s"><div className="row-between"><span>{ex}</span><span className="meta">{Math.max(...vals)} kg max</span></div><Sparkline values={vals} label={`Carichi ${ex}`} /></div>) : <Empty>Registra almeno due serie con carico per vedere i progressi.</Empty>}
        </Card>
        <Card className="w-6" title="Storico">
          {history.length ? <ul className="list">{history.map((s) => <li key={s.id}><span className="grow">{tplName(s)}</span><span className="meta">{formatLocal(s.performed_at ?? s.planned_for!, tz, false)}{s.duration_minutes ? ` · ${s.duration_minutes} min` : ""}{s.perceived_effort ? ` · fatica ${s.perceived_effort}` : ""}</span></li>)}</ul> : <Empty>Nessun allenamento registrato.</Empty>}
        </Card>
      </div>
    </>
  );
}
