import Link from "next/link";
import { Timeline, type TimelineBlock } from "@/components/Timeline";
import { Badge, Card, Empty, MinuteBars, PageHeader, Sparkline, Stat } from "@/components/ui";
import { AREA_LABEL, type LifeArea } from "@/lib/domain";
import { integrationStatus, serverEnv } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { sleptMinutes } from "@/lib/sleep";
import { addDays, dayBoundsUtc, formatDuration, formatTime, weekStart } from "@/lib/time";
import { toggleHabit } from "./abitudini/actions";
import { askAssistantAction } from "./assistente/actions";

export const metadata = { title: "Dashboard" };

export default async function Dashboard() {
  const { db, profile, today, tz, user } = await requireUser();
  const ws = weekStart(today);
  const { start: weekFrom } = dayBoundsUtc(ws, tz);
  const nowIso = new Date().toISOString();
  const [blocks, sleep, ironedge, habits, logs, entries, deadlines, proposals, notifs, syncState] = await Promise.all([
    db.from("schedule_blocks").select("id, starts_at, ends_at, title, area, kind, flexibility, status").eq("plan_date", today).not("kind", "in", "(sleep)").order("starts_at"),
    db.from("sleep_logs").select("night_of, slept_minutes, bedtime, wake_time").gte("night_of", addDays(today, -14)).order("night_of"),
    db.from("tasks").select("id, title, due_at").eq("source", "ironedge").in("status", ["todo", "in_progress"]).order("due_at").limit(5),
    db.from("habits").select("id, name, area").eq("active", true).order("created_at").limit(6),
    db.from("habit_logs").select("habit_id").eq("log_date", today),
    db.from("time_entries").select("area, minutes").gte("started_at", weekFrom.toISOString()),
    db.from("tasks").select("id, title, due_at, area").in("status", ["todo", "in_progress"]).not("due_at", "is", null).lte("due_at", dayBoundsUtc(addDays(today, 2), tz).end.toISOString()).order("due_at").limit(6),
    db.from("plan_proposals").select("id, summary").eq("status", "pending").order("created_at", { ascending: false }).limit(3),
    db.from("notifications").select("id, title, created_at").is("read_at", null).order("created_at", { ascending: false }).limit(4),
    db.from("integration_state").select("provider, last_success_at, last_error").eq("user_id", user.id),
  ]);
  const tl = (blocks.data ?? []) as TimelineBlock[];
  const upcoming = tl.filter((b) => b.ends_at > nowIso && !["break", "buffer", "travel"].includes(b.kind)).slice(0, 6);
  const sleepRows = sleep.data ?? [];
  const last = sleepRows.find((s) => s.night_of === addDays(today, -1));
  const lastMin = last ? sleptMinutes(last) : null;
  const byArea = new Map<LifeArea, number>();
  for (const e of entries.data ?? []) byArea.set(e.area as LifeArea, (byArea.get(e.area as LifeArea) ?? 0) + e.minutes);
  const done = new Set((logs.data ?? []).map((l) => l.habit_id));
  const st = integrationStatus(serverEnv());
  const ieState = (syncState.data ?? []).find((s) => s.provider === "ironedge");
  const workPlanned = tl.filter((b) => ["marketing", "trading", "ironedge"].includes(b.area) && b.kind !== "break").reduce((a, b) => a + (Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60000, 0);
  const hour = Number(formatTime(new Date(), tz).slice(0, 2));

  return (
    <>
      <PageHeader
        title={`${hour < 12 ? "Buongiorno" : hour < 18 ? "Buon pomeriggio" : "Buonasera"}${profile.display_name ? `, ${profile.display_name}` : ""}`}
        sub={new Intl.DateTimeFormat("it-IT", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date())}
        actions={<Link className="btn primary" href="/oggi">Apri l&apos;agenda</Link>}
      />
      <div className="bento">
        <Card className="w-8 h-2" title="Prossimi impegni" action={<Link href="/oggi" className="meta">Timeline completa</Link>}>
          {tl.length === 0 ? (
            <Empty>Nessun piano per oggi. <Link href="/oggi">Genera il piano</Link> oppure chiedi all&apos;assistente.</Empty>
          ) : upcoming.length ? (
            <Timeline blocks={upcoming} tz={tz} now={new Date()} />
          ) : (
            <Empty>Giornata pianificata conclusa. Buon riposo.</Empty>
          )}
          <div className="row meta">
            <span>Lavoro pianificato oggi: {formatDuration(workPlanned)} su {formatDuration(profile.max_work_minutes_per_day)} massimi</span>
          </div>
        </Card>

        <Card className="w-4 accent" title="Assistente">
          <form action={askAssistantAction} className="stack-s">
            <label className="sr-only" htmlFor="q">Chiedi all&apos;assistente</label>
            <input id="q" name="message" placeholder="Es. Organizzami la giornata di domani" maxLength={2000} required />
            <input type="hidden" name="back" value="/assistente" />
            <button className="btn primary" type="submit">Chiedi</button>
          </form>
          <div className="suggestions">
            {["Quali task IronEdge sono ancora incomplete?", "Quali clienti sto trascurando?"].map((s) => (
              <form action={askAssistantAction} key={s}><input type="hidden" name="message" value={s} /><input type="hidden" name="back" value="/assistente" /><button className="btn small" type="submit">{s}</button></form>
            ))}
          </div>
        </Card>

        <Card className="w-4" title="Sonno" action={<Link href="/sonno" className="meta">Dettagli</Link>}>
          <div className="row-between">
            <Stat value={lastMin != null ? formatDuration(lastMin) : "—"} label={lastMin != null ? "stanotte" : "stanotte non registrato"} />
            <Stat value={formatDuration(profile.sleep_goal_minutes)} label="obiettivo" />
          </div>
          <Sparkline values={Array.from({ length: 14 }, (_, i) => { const r = sleepRows.find((s) => s.night_of === addDays(today, i - 14)); return r ? sleptMinutes(r) : null; })} goal={profile.sleep_goal_minutes} label="Ore dormite negli ultimi 14 giorni" />
          <p className="meta">Riposo previsto alle {profile.target_bedtime.slice(0, 5)} · sveglia {profile.target_wake.slice(0, 5)}</p>
        </Card>

        <Card className="w-4" title="Task IronEdge" action={<Badge tone={st.ironedge ? "accent" : undefined}>{st.ironedge ? "collegato" : "da configurare"}</Badge>}>
          {!st.ironedge ? (
            <p className="meta">Integrazione non configurata: vedi Impostazioni › Integrazioni.</p>
          ) : ironedge.data?.length ? (
            <ul className="list">
              {ironedge.data.map((t) => (
                <li key={t.id}><span className="area-dot area-ironedge" /><span className="grow truncate">{t.title}</span>{t.due_at ? <span className="meta">{new Date(t.due_at).toLocaleDateString("it-IT", { timeZone: tz, day: "numeric", month: "short" })}</span> : null}</li>
              ))}
            </ul>
          ) : (
            <Empty>Nessuna task IronEdge aperta.</Empty>
          )}
          {ieState?.last_success_at ? <p className="meta">Sincronizzato {new Date(ieState.last_success_at).toLocaleString("it-IT", { timeZone: tz, hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</p> : st.ironedge ? <p className="meta">Prima sincronizzazione in attesa.</p> : null}
          {ieState?.last_error ? <Badge tone="warning">Ultimo errore: {ieState.last_error.slice(0, 60)}</Badge> : null}
        </Card>

        <Card className="w-4" title="Scadenze vicine">
          {deadlines.data?.length ? (
            <ul className="list">
              {deadlines.data.map((t) => (
                <li key={t.id} className={`area-${t.area}`}><span className="area-dot" /><span className="grow truncate">{t.title}</span><span className={`meta ${t.due_at! < nowIso ? "badge danger" : ""}`}>{t.due_at! < nowIso ? "scaduta" : new Date(t.due_at!).toLocaleDateString("it-IT", { timeZone: tz, weekday: "short", day: "numeric" })}</span></li>
              ))}
            </ul>
          ) : (
            <Empty>Nessuna scadenza nei prossimi 2 giorni.</Empty>
          )}
        </Card>

        <Card className="w-4" title="Abitudini di oggi" action={<Link href="/abitudini" className="meta">Gestisci</Link>}>
          {habits.data?.length ? (
            <ul className="list">
              {habits.data.map((h) => (
                <li key={h.id}>
                  <form action={toggleHabit} className="row grow">
                    <input type="hidden" name="habit_id" value={h.id} /><input type="hidden" name="date" value={today} /><input type="hidden" name="back" value="/" />
                    <button type="submit" className={`habit-cell ${done.has(h.id) ? "on" : ""}`} aria-pressed={done.has(h.id)} aria-label={`${h.name}: ${done.has(h.id) ? "fatto" : "da fare"}`} />
                    <span className="grow">{h.name}</span>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nessuna abitudine. <Link href="/abitudini">Aggiungine una</Link>.</Empty>
          )}
        </Card>

        <Card className="w-4" title="Tempo questa settimana" action={<Link href="/report" className="meta">Report</Link>}>
          <MinuteBars rows={[...byArea.entries()].sort((a, b) => b[1] - a[1]).map(([area, minutes]) => ({ label: AREA_LABEL[area], minutes, area }))} />
        </Card>

        <Card className="w-4" title="Da decidere">
          {proposals.data?.length ? (
            <ul className="list">
              {proposals.data.map((p) => <li key={p.id}><span className="grow">{p.summary}</span></li>)}
            </ul>
          ) : (
            <Empty>Nessuna proposta in attesa.</Empty>
          )}
          {proposals.data?.length ? <Link className="btn small" href="/oggi#proposte">Rivedi e approva</Link> : null}
        </Card>

        <Card className="w-4" title="Notifiche">
          {notifs.data?.length ? (
            <ul className="list">{notifs.data.map((n) => <li key={n.id}><span className="grow truncate">{n.title}</span><span className="meta">{formatTime(n.created_at, tz)}</span></li>)}</ul>
          ) : (
            <Empty>Nessuna notifica non letta.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
