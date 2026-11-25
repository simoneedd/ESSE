import Link from "next/link";
import { z } from "zod";
import { Card, PageHeader, readSp, type SP } from "@/components/ui";
import { requireUser } from "@/lib/session";
import { addDays, dayBoundsUtc, formatTime, localDate, weekStart } from "@/lib/time";

export const metadata = { title: "Calendario" };

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz } = await requireUser();
  const anchor = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(sp.w).data ?? today;
  const ws = weekStart(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const from = dayBoundsUtc(days[0], tz).start.toISOString();
  const to = dayBoundsUtc(days[6], tz).end.toISOString();
  const [events, blocks, trading, workouts] = await Promise.all([
    db.from("events").select("id, title, area, starts_at, ends_at, origin").gte("starts_at", from).lt("starts_at", to).order("starts_at"),
    db.from("schedule_blocks").select("id, title, area, starts_at, ends_at, kind, plan_date, status").gte("plan_date", days[0]).lte("plan_date", days[6]).not("kind", "in", "(sleep,wind_down,break,buffer,travel,event)").order("starts_at"),
    db.from("trading_sessions").select("id, title, starts_at, ends_at").gte("starts_at", from).lt("starts_at", to),
    db.from("workout_sessions").select("id, planned_for, status, template:workout_templates(name)").gte("planned_for", from).lt("planned_for", to),
  ]);
  type Item = { id: string; title: string; area: string; start: string; end?: string; tag?: string };
  const items: Item[] = [
    ...(events.data ?? []).map((e) => ({ id: e.id, title: e.title, area: e.area, start: e.starts_at, end: e.ends_at, tag: e.origin === "google" ? "Google" : "fisso" })),
    ...(blocks.data ?? []).map((b) => ({ id: b.id, title: b.title, area: b.area, start: b.starts_at, end: b.ends_at, tag: b.status === "done" ? "fatto" : undefined })),
    ...(trading.data ?? []).filter((t) => !(blocks.data ?? []).some((b) => b.title === t.title)).map((t) => ({ id: t.id, title: t.title, area: "trading", start: t.starts_at, end: t.ends_at })),
    ...(workouts.data ?? []).filter((w) => w.planned_for).map((w) => ({ id: w.id, title: (w as unknown as { template: { name: string } | null }).template?.name ?? "Allenamento", area: "gym", start: w.planned_for!, tag: w.status === "done" ? "fatto" : "da collocare" })),
  ];
  return (
    <>
      <PageHeader
        title="Calendario"
        sub={`Settimana dal ${new Date(from).toLocaleDateString("it-IT", { timeZone: tz, day: "numeric", month: "long" })}`}
        actions={<>
          <Link className="btn small" href={`/calendario?w=${addDays(ws, -7)}`} aria-label="Settimana precedente">‹</Link>
          <Link className="btn small" href="/calendario">Questa settimana</Link>
          <Link className="btn small" href={`/calendario?w=${addDays(ws, 7)}`} aria-label="Settimana successiva">›</Link>
        </>}
      />
      <div className="week" role="list">
        {days.map((d) => {
          const list = items.filter((i) => localDate(new Date(i.start), tz) === d).sort((a, b) => a.start.localeCompare(b.start));
          return (
            <div key={d} className={`week-day ${d === today ? "today" : ""}`} role="listitem">
              <h3><Link href={`/oggi?d=${d}`}>{new Date(dayBoundsUtc(d, tz).start).toLocaleDateString("it-IT", { timeZone: tz, weekday: "short", day: "numeric" })}</Link><span className="meta">{list.length || ""}</span></h3>
              {list.length ? list.map((i) => (
                <div key={i.id} className={`chip area-${i.area}`}>
                  <b className="truncate">{i.title}</b>
                  <span className="meta">{formatTime(i.start, tz)}{i.end ? `–${formatTime(i.end, tz)}` : ""}{i.tag ? ` · ${i.tag}` : ""}</span>
                </div>
              )) : <span className="meta">Libero</span>}
            </div>
          );
        })}
      </div>
      <Card className="" title="Legenda">
        <p className="meta">Gli impegni fissi e gli eventi Google non vengono spostati automaticamente. I blocchi flessibili derivano dal piano giornaliero: apri un giorno per ripianificarlo.</p>
      </Card>
    </>
  );
}
