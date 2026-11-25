import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { serverEnv } from "@/lib/env";
import { requireUser } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase/server";
import { formatLocal } from "@/lib/time";

export const metadata = { title: "Sicurezza" };

export default async function SecurityPage() {
  const { db, user, tz } = await requireUser();
  const env = serverEnv();
  const isOwner = Boolean(env.OWNER_USER_ID && env.OWNER_USER_ID === user.id && env.SUPABASE_SERVICE_ROLE_KEY);
  const [audit, findings] = await Promise.all([
    db.from("audit_events").select("id, actor, action, entity, fields, created_at").order("created_at", { ascending: false }).limit(30),
    isOwner ? supabaseAdmin().from("security_findings").select("id, scanner, severity, title, package_name, fixed_version, status, last_seen").neq("status", "fixed").order("last_seen", { ascending: false }).limit(50) : Promise.resolve({ data: null }),
  ]);
  return (
    <>
      <PageHeader title="Sicurezza" sub="Vulnerabilita' rilevate dalle scansioni quotidiane e registro delle azioni." />
      <div className="stack">
        <Card title="Vulnerabilita' aperte">
          {!isOwner ? <p className="meta">Visibile solo al proprietario configurato (OWNER_USER_ID).</p> : findings.data?.length ? (
            <div className="table-wrap"><table><thead><tr><th>Gravita&apos;</th><th>Titolo</th><th>Pacchetto</th><th>Fix</th><th>Ultima rilevazione</th></tr></thead><tbody>
              {findings.data.map((f) => <tr key={f.id}><td><Badge tone={["critical", "high"].includes(f.severity) ? "danger" : f.severity === "moderate" ? "warning" : undefined}>{f.severity}</Badge></td><td>{f.title}</td><td>{f.package_name ?? "—"}</td><td>{f.fixed_version ?? "—"}</td><td>{formatLocal(f.last_seen, tz)}</td></tr>)}
            </tbody></table></div>
          ) : <Empty>Nessuna vulnerabilita&apos; aperta registrata dalle scansioni.</Empty>}
          <p className="meta">Scansioni: npm audit, firme registry, OSV-Scanner e gitleaks ogni giorno via GitHub Actions; correzioni automatiche solo patch/minor tramite PR, mai merge diretto.</p>
        </Card>
        <Card title="Registro azioni (approvazioni, modifiche sensibili)">
          {audit.data?.length ? <ul className="list">{audit.data.map((a) => <li key={a.id}><span className="grow">{a.action} · {a.entity}{a.fields?.length ? ` (${a.fields.join(", ")})` : ""}</span><span className="meta">{a.actor} · {formatLocal(a.created_at, tz)}</span></li>)}</ul> : <Empty>Nessuna azione registrata.</Empty>}
        </Card>
      </div>
    </>
  );
}
