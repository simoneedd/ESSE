import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Card, Empty, Flash, PageHeader, readSp, Sparkline, Stat, type SP } from "@/components/ui";
import { requireUser } from "@/lib/session";
import { sleepStats, sleepSuggestions, sleptMinutes } from "@/lib/sleep";
import { addDays, formatDuration, formatTime } from "@/lib/time";
import { logSleep, planWakeAction } from "./actions";

export const metadata = { title: "Sonno" };

export default async function SleepPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz, profile } = await requireUser();
  const [logs, wakes] = await Promise.all([
    db.from("sleep_logs").select("id, night_of, bedtime, wake_time, slept_minutes, quality, source").gte("night_of", addDays(today, -30)).order("night_of", { ascending: false }),
    db.from("wake_plans").select("for_date, wake_at, bedtime_target, mechanism").gte("for_date", today).order("for_date").limit(5),
  ]);
  const rows = logs.data ?? [];
  const last14 = rows.filter((r) => r.night_of >= addDays(today, -14));
  const s14 = sleepStats(last14, profile.sleep_goal_minutes, tz);
  const s30 = sleepStats(rows, profile.sleep_goal_minutes, tz);
  const series = Array.from({ length: 30 }, (_, i) => { const r = rows.find((x) => x.night_of === addDays(today, i - 30)); return r ? sleptMinutes(r) : null; });
  return (
    <>
      <PageHeader title="Sonno" sub={`Obiettivo ${formatDuration(profile.sleep_goal_minutes)} · coricarsi ${profile.target_bedtime.slice(0, 5)} · sveglia ${profile.target_wake.slice(0, 5)}`} />
      <Flash sp={sp} />
      <div className="bento">
        <Card className="w-3"><Stat value={s14.avgMinutes != null ? formatDuration(s14.avgMinutes) : "—"} label="media 14 notti" /></Card>
        <Card className="w-3"><Stat value={s14.nights ? `${s14.nightsBelowGoal}/${s14.nights}` : "—"} label="notti sotto obiettivo" /></Card>
        <Card className="w-3"><Stat value={s14.regularity} label="regolarita' degli orari" /></Card>
        <Card className="w-3"><Stat value={s14.avgBedtime ?? "—"} label={`coricarsi medio${s14.bedtimeSdMinutes != null ? ` (±${s14.bedtimeSdMinutes} min)` : ""}`} /></Card>

        <Card className="w-8" title="Ultimi 30 giorni">
          <Sparkline values={series} goal={profile.sleep_goal_minutes} label="Minuti dormiti per notte, linea tratteggiata = obiettivo" />
          <ul className="list">{sleepSuggestions(s30).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </Card>
        <Card className="w-4" title="Registra la notte">
          <form action={logSleep} className="stack">
            <label>Notte del<input type="date" name="night_of" defaultValue={addDays(today, -1)} max={today} /></label>
            <div className="form-grid">
              <label>A letto alle<input type="time" name="bedtime" /></label>
              <label>Sveglia alle<input type="time" name="wake" /></label>
              <label>Ore dormite<input type="number" name="hours" min={0} max={20} step={0.25} placeholder="se diverse" /></label>
              <label>Qualita&apos; (1-5)<input type="number" name="quality" min={1} max={5} /></label>
            </div>
            <label>Fonte (se importato)<input name="import_source" maxLength={60} placeholder="es. Apple Salute, smartwatch" /></label>
            <SubmitButton>Salva</SubmitButton>
          </form>
          <p className="meta">Ore inserite a mano o lette da un&apos;app autorizzata: Personal OS non accede direttamente ai dati dei dispositivi.</p>
        </Card>

        <Card className="w-6" title="Pianifica la sveglia">
          <form action={planWakeAction} className="form-grid">
            <label>Giorno<input type="date" name="date" defaultValue={addDays(today, 1)} /></label>
            <label>Sveglia<input type="time" name="wake" required defaultValue={profile.target_wake.slice(0, 5)} /></label>
            <label>Modalita&apos;<select name="mechanism" defaultValue="reminder"><option value="reminder">Promemoria Personal OS</option><option value="calendar">Evento Google Calendar con avviso</option><option value="native_manual">La imposto io sul telefono</option></select></label>
            <SubmitButton>Calcola</SubmitButton>
          </form>
          {wakes.data?.length ? <ul className="list">{wakes.data.map((w) => <li key={w.for_date}><span className="grow">{w.for_date}: sveglia {formatTime(w.wake_at, tz)}{w.bedtime_target ? ` · a letto ${formatTime(w.bedtime_target, tz)}` : ""}</span><Badge>{w.mechanism === "reminder" ? "promemoria" : w.mechanism === "calendar" ? "calendario" : "manuale"}</Badge></li>)}</ul> : null}
          <p className="notice">Importante: un&apos;app web non puo&apos; attivare la sveglia nativa del telefono. Personal OS invia un promemoria serale e, se colleghi Google Calendar, un evento con avviso; la sveglia vera va impostata nell&apos;app Orologio.</p>
        </Card>
        <Card className="w-6" title="Storico">
          {rows.length ? (
            <div className="table-wrap"><table><thead><tr><th>Notte</th><th>A letto</th><th>Sveglia</th><th>Dormito</th><th>Qualita&apos;</th></tr></thead><tbody>
              {rows.slice(0, 14).map((r) => <tr key={r.id}><td>{r.night_of}</td><td>{r.bedtime ? formatTime(r.bedtime, tz) : "—"}</td><td>{r.wake_time ? formatTime(r.wake_time, tz) : "—"}</td><td>{formatDuration(sleptMinutes(r))}</td><td>{r.quality ?? "—"}</td></tr>)}
            </tbody></table></div>
          ) : <Empty>Nessuna notte registrata.</Empty>}
        </Card>
      </div>
    </>
  );
}
