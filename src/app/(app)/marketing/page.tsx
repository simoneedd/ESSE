import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Card, Empty, Flash, MinuteBars, PageHeader, readSp, type SP } from "@/components/ui";
import { PRIORITY_LABEL } from "@/lib/domain";
import { allocateClientTime } from "@/lib/reports";
import { requireUser } from "@/lib/session";
import { addDays, currentTimeMs, dayBoundsUtc, formatDuration, weekStart } from "@/lib/time";
import { createClientAction } from "./actions";

export const metadata = { title: "Marketing" };

export default async function MarketingPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz, profile } = await requireUser();
  const ws = weekStart(today);
  const from = dayBoundsUtc(ws, tz).start.toISOString();
  const [clients, entries, tasks] = await Promise.all([
    db.from("clients").select("id, name, priority, weekly_target_minutes, active, color").order("active", { ascending: false }).order("priority").order("name"),
    db.from("time_entries").select("client_id, minutes").eq("area", "marketing").gte("started_at", from),
    db.from("tasks").select("client_id, due_at, status").in("status", ["todo", "in_progress"]).not("client_id", "is", null),
  ]);
  const spent = new Map<string, number>();
  for (const e of entries.data ?? []) if (e.client_id) spent.set(e.client_id, (spent.get(e.client_id) ?? 0) + e.minutes);
  const nowMs = currentTimeMs();
  const nearest = new Map<string, number>();
  const open = new Map<string, number>();
  for (const t of tasks.data ?? []) {
    open.set(t.client_id!, (open.get(t.client_id!) ?? 0) + 1);
    if (t.due_at) {
      const d = Math.max(0, Math.ceil((Date.parse(t.due_at) - nowMs) / 86_400_000));
      nearest.set(t.client_id!, Math.min(nearest.get(t.client_id!) ?? 999, d));
    }
  }
  const active = (clients.data ?? []).filter((c) => c.active);
  const remainingDays = Math.max(1, 7 - Math.round((Date.parse(today) - Date.parse(ws)) / 86_400_000));
  const suggestion = allocateClientTime(
    active.map((c) => ({ id: c.id, name: c.name, priority: c.priority, weeklyTarget: c.weekly_target_minutes, spent: spent.get(c.id) ?? 0, nearestDueDays: nearest.get(c.id) ?? null })),
    Math.round(profile.max_work_minutes_per_day * 0.6),
  );
  return (
    <>
      <PageHeader title="Marketing" sub={`Clienti attivi: ${active.length} · settimana dal ${ws}`} />
      <Flash sp={sp} />
      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <div className="stack">
          <Card title="Clienti">
            {clients.data?.length ? (
              <ul className="list">
                {clients.data.map((c) => (
                  <li key={c.id}>
                    <span className="area-dot" style={{ background: c.color ?? "var(--area-marketing)" }} />
                    <Link className="grow truncate" href={`/marketing/${c.id}`}>{c.name}</Link>
                    {!c.active ? <Badge>archiviato</Badge> : null}
                    <Badge tone={c.priority === 1 ? "danger" : c.priority === 2 ? "warning" : undefined}>{PRIORITY_LABEL[c.priority]}</Badge>
                    <span className="meta">{open.get(c.id) ?? 0} task</span>
                    <span className="meta">{formatDuration(spent.get(c.id) ?? 0)}{c.weekly_target_minutes ? ` / ${formatDuration(c.weekly_target_minutes)}` : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Nessun cliente. Aggiungi il primo dal modulo a destra.</Empty>
            )}
          </Card>
          <Card title="Tempo per cliente (settimana)">
            <MinuteBars rows={active.map((c) => ({ label: c.name, minutes: spent.get(c.id) ?? 0, target: c.weekly_target_minutes, area: "marketing" as const }))} />
          </Card>
        </div>
        <div className="stack">
          <Card title="Distribuzione suggerita per oggi" className="accent">
            {suggestion.length ? (
              <ul className="list">{suggestion.map((s) => <li key={s.id}><span className="grow">{s.name}</span><span className="meta">{formatDuration(s.minutes)} · {s.reason}</span></li>)}</ul>
            ) : (
              <p className="meta">Nessuna indicazione: imposta un obiettivo settimanale o scadenze sui clienti.</p>
            )}
            <p className="meta">Calcolata su priorita&apos;, scadenze ({remainingDays} giorni rimanenti) e obiettivi; non supera il 60% della tua capacita&apos; giornaliera.</p>
          </Card>
          <Card title="Nuovo cliente">
            <form action={createClientAction} className="stack">
              <label>Nome<input name="name" required maxLength={120} /></label>
              <div className="form-grid">
                <label>Priorita&apos;<select name="priority" defaultValue="2">{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
                <label>Ore/settimana<input type="number" name="weekly_hours" min={0} max={100} step={0.5} /></label>
                <label>Colore<input type="color" name="color" defaultValue="#d0612f" /></label>
              </div>
              <label>Note<textarea name="notes" maxLength={4000} placeholder="Riferimenti, servizi, preferenze (resta in Personal OS)" /></label>
              <SubmitButton>Aggiungi cliente</SubmitButton>
            </form>
          </Card>
        </div>
      </div>
      <p className="meta" style={{ marginTop: 12 }}>Dati di questa settimana fino al {addDays(today, 0)}.</p>
    </>
  );
}
