import type { ReactNode } from "react";
import type { LifeArea } from "@/lib/domain";
import { formatTime } from "@/lib/time";

export type TimelineBlock = {
  id: string;
  starts_at: string;
  ends_at: string;
  title: string;
  area: LifeArea;
  kind: string;
  flexibility: string;
  status: string;
  task_id?: string | null;
};

const KIND_LABEL: Record<string, string> = {
  event: "Impegno", meal: "Pasto", workout: "Allenamento", study: "Studio", trading: "Trading", break: "Pausa",
  buffer: "Margine", travel: "Spostamento", sleep: "Sonno", wind_down: "Routine serale", task: "Attivita'",
};

export function Timeline({ blocks, tz, now, actions, compact }: { blocks: TimelineBlock[]; tz: string; now?: Date; actions?: (b: TimelineBlock) => ReactNode; compact?: boolean }) {
  const nowIso = now?.toISOString();
  const nowIdx = nowIso ? blocks.findIndex((x) => x.starts_at > nowIso) : -1;
  return (
    <ol className="timeline" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {blocks.map((b, idx) => {
        const showNow = idx === nowIdx;
        const cls = ["tl-block", `area-${b.area}`, b.flexibility === "fixed" ? "fixed" : "", b.status === "done" ? "done" : "", b.status === "skipped" ? "muted" : "", ["break", "buffer", "travel"].includes(b.kind) ? b.kind : ""].join(" ");
        return (
          <li key={b.id}>
            {showNow ? <div className="tl-now" aria-label="Adesso" /> : null}
            <div className="tl-item">
              <span className="tl-time">{formatTime(b.starts_at, tz)}</span>
              <div className={cls}>
                <div className="stack-s grow">
                  <span className="tl-title truncate">{b.title}</span>
                  {!compact ? (
                    <span className="meta">
                      {formatTime(b.starts_at, tz)}–{formatTime(b.ends_at, tz)} · {KIND_LABEL[b.kind] ?? b.kind}
                      {b.flexibility === "fixed" ? " · fisso" : ""}
                      {b.status !== "planned" ? ` · ${b.status === "done" ? "fatto" : b.status === "partial" ? "parziale" : b.status === "skipped" ? "non svolto" : b.status}` : ""}
                    </span>
                  ) : null}
                </div>
                {actions ? actions(b) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
