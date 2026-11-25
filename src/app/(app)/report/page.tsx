import Link from "next/link";
import { z } from "zod";
import { Card, Empty, MinuteBars, PageHeader, readSp, Stat, type SP } from "@/components/ui";
import { AREA_LABEL, type LifeArea } from "@/lib/domain";
import { buildWeekly } from "@/lib/jobs";
import { requireUser } from "@/lib/session";
import { addDays, formatDuration, weekStart } from "@/lib/time";

export const metadata = { title: "Report" };

export default async function ReportPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, profile, today } = await requireUser();
  const period = z.enum(["week", "last_week", "month"]).catch("week").parse(sp.p);
  const ws = weekStart(today);
  const [start, end] = period === "week" ? [ws, today] : period === "last_week" ? [addDays(ws, -7), addDays(ws, -1)] : [`${today.slice(0, 8)}01`, today];
  const r = await buildWeekly(db, profile, start, end);
  const { data: stored } = await db.from("reports").select("id, kind, period_start, period_end").in("kind", ["weekly", "monthly"]).order("period_start", { ascending: false }).limit(10);
  const freeDays = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  return (
    <>
      <PageHeader
        title="Report"
        sub={`Periodo ${start} → ${end}. Calcoli solo su dati registrati.`}
        actions={<>
          <Link className="btn small" aria-current={period === "week" ? "page" : undefined} href="/report?p=week">Questa settimana</Link>
          <Link className="btn small" aria-current={period === "last_week" ? "page" : undefined} href="/report?p=last_week">Settimana scorsa</Link>
          <Link className="btn small" aria-current={period === "month" ? "page" : undefined} href="/report?p=month">Mese</Link>
        </>}
      />
      <div className="bento">
        <Card className="w-3"><Stat value={r.sleepAvgMinutes != null ? formatDuration(r.sleepAvgMinutes) : "—"} label="sonno medio" /></Card>
        <Card className="w-3"><Stat value={formatDuration(r.workMinutes)} label={`lavoro (media ${formatDuration(r.avgWorkPerDay)}/g)`} /></Card>
        <Card className="w-3"><Stat value={`${r.workouts.done}/${r.workouts.planned}`} label="allenamenti svolti/pianificati" /></Card>
        <Card className="w-3"><Stat value={formatDuration(r.studyMinutes)} label="studio" /></Card>
        <Card className="w-3"><Stat value={r.tasks.completed} label="task completate" /></Card>
        <Card className="w-3"><Stat value={r.tasks.postponed} label="task rimandate" /></Card>
        <Card className="w-3"><Stat value={r.habitCompletion != null ? `${Math.round(r.habitCompletion * 100)}%` : "—"} label="regolarita' abitudini" /></Card>
        <Card className="w-3"><Stat value={r.tasks.open} label="task aperte" /></Card>

        <Card className="w-6" title="Tempo per area"><MinuteBars rows={Object.entries(r.minutesByArea).sort((a, b) => b[1] - a[1]).map(([a, m]) => ({ label: AREA_LABEL[a as LifeArea] ?? a, minutes: m, area: a as LifeArea }))} /></Card>
        <Card className="w-6" title="Tempo per cliente"><MinuteBars rows={r.minutesByClient.map((c) => ({ label: c.name, minutes: c.minutes, target: c.target, area: "marketing" as const }))} /></Card>
        <Card className="w-6" title="Pianificato vs effettivo">
          {r.plannedVsActual.length ? (
            <div className="table-wrap"><table><thead><tr><th>Area</th><th>Pianificato</th><th>Effettivo</th><th>Differenza</th></tr></thead><tbody>
              {r.plannedVsActual.map((p) => <tr key={p.area}><td>{p.area}</td><td>{formatDuration(p.planned)}</td><td>{p.actual != null ? formatDuration(p.actual) : "non registrato"}</td><td>{p.actual != null ? formatDuration(p.actual - p.planned) : "—"}</td></tr>)}
            </tbody></table></div>
          ) : <Empty>Nessun piano nel periodo.</Empty>}
        </Card>
        <Card className="w-6 accent" title="Suggerimenti per bilanciare">
          {r.suggestions.length ? <ul className="list">{r.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="meta">Nessun segnale critico nel periodo.</p>}
          <p className="meta">Tempo libero: calcolabile solo registrando il tempo effettivo ({freeDays} giorni nel periodo). I suggerimenti non propongono mai piu&apos; ore di lavoro o meno sonno.</p>
        </Card>
        <Card className="w-12" title="Report automatici salvati">
          {stored?.length ? <ul className="list">{stored.map((s) => <li key={s.id}><span className="grow">{s.kind === "weekly" ? "Settimanale" : "Mensile"}</span><span className="meta">{s.period_start} → {s.period_end}</span></li>)}</ul> : <Empty>Nessun report automatico ancora: vengono creati dallo scheduler cloud.</Empty>}
        </Card>
      </div>
    </>
  );
}
