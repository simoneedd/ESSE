import type { ReactNode } from "react";
import { AREA_LABEL, type LifeArea } from "@/lib/domain";
import { formatDuration } from "@/lib/time";

export type SP = Promise<Record<string, string | string[] | undefined>>;
export async function readSp(sp: SP) {
  const r = await sp;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, action, children, className = "", icon }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <section className={`card ${className}`}>
      {title || action ? (
        <div className="card-head">
          {title ? <h2>{icon}{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "warning" | "danger" | "positive" }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

export function AreaTag({ area }: { area: LifeArea }) {
  return (
    <span className={`badge area-${area}`}>
      <span className="area-dot" aria-hidden="true" />
      {AREA_LABEL[area]}
    </span>
  );
}

export function Flash({ sp }: { sp: Record<string, string | undefined> }) {
  if (sp.err) return <div role="alert" className="flash err">{sp.err.slice(0, 300)}</div>;
  if (sp.ok) return <div role="status" aria-live="polite" className="flash ok">{sp.ok.slice(0, 300)}</div>;
  return null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Progress({ value, label }: { value: number | null; label: string }) {
  if (value == null) return <span className="meta">{label}: dati insufficienti</span>;
  return (
    <div className="stack-s" aria-label={`${label}: ${value}%`}>
      <div className="row-between meta"><span>{label}</span><span>{value}%</span></div>
      <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, value)}%` }} /></div>
    </div>
  );
}

/** Barre orizzontali per minuti per area/cliente. Nessun valore = messaggio, mai 0 inventati. */
export function MinuteBars({ rows }: { rows: { label: string; minutes: number; area?: LifeArea; target?: number | null }[] }) {
  if (!rows.length) return <Empty>Nessun tempo registrato nel periodo.</Empty>;
  const max = Math.max(...rows.map((r) => Math.max(r.minutes, r.target ?? 0)), 1);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className={`bar-row ${r.area ? `area-${r.area}` : ""}`} key={r.label}>
          <span className="truncate">{r.label}</span>
          <div className="bar-track" aria-hidden="true"><div className="bar-fill" style={{ width: `${(r.minutes / max) * 100}%` }} /></div>
          <span className="meta">{formatDuration(r.minutes)}{r.target ? ` / ${formatDuration(r.target)}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** Sparkline SVG inline con linea obiettivo opzionale. */
export function Sparkline({ values, goal, label }: { values: (number | null)[]; goal?: number; label: string }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  if (pts.length < 2) return <p className="meta">{label}: servono almeno 2 rilevazioni.</p>;
  const w = 300;
  const h = 64;
  const all = [...pts.map((p) => p.v), goal ?? pts[0].v];
  const min = Math.min(...all) * 0.9;
  const max = Math.max(...all) * 1.05;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / Math.max(1, max - min)) * h;
  const line = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1].i).toFixed(1)},${h} L${x(pts[0].i).toFixed(1)},${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path className="area" d={area} />
      <path className="line" d={line} />
      {goal != null ? <line className="goal" x1="0" x2={w} y1={y(goal)} y2={y(goal)} /> : null}
    </svg>
  );
}
