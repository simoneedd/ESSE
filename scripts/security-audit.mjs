#!/usr/bin/env node
/**
 * Audit di sicurezza e inventario della supply chain (senza dipendenze esterne).
 * - vulnerabilita' npm (npm audit, dirette e transitive);
 * - inventario dipendenze dirette/transitive con licenze;
 * - inventario GitHub Actions (uses + pinning SHA) e permessi dei workflow;
 * - inventario servizi/API di terze parti dichiarati nel codice;
 * - report Markdown + JSON in security-reports/;
 * - opzionale: invio finding al Security Center (SECURITY_INGEST_URL + SECURITY_INGEST_SECRET).
 * Uso: node scripts/security-audit.mjs [--fail-on=high|critical|none]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, "security-reports");
const failOn = (process.argv.find((a) => a.startsWith("--fail-on="))?.split("=")[1] ?? "critical").toLowerCase();
const SEV = ["info", "low", "moderate", "high", "critical"];
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args) {
  try {
    return execFileSync(npmCmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
  } catch (e) {
    // npm audit esce con codice != 0 quando trova vulnerabilita': l'output resta valido
    return e.stdout?.toString() ?? "";
  }
}

// 1. npm audit
const auditRaw = run(["audit", "--json"]);
let audit = {};
try {
  audit = JSON.parse(auditRaw || "{}");
} catch {
  audit = { error: "output npm audit non leggibile" };
}
const findings = [];
for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
  const via = (v.via ?? []).filter((x) => typeof x === "object");
  const titles = via.map((x) => x.title).filter(Boolean);
  const ids = via.map((x) => x.url?.split("/").pop()).filter(Boolean);
  findings.push({
    fingerprint: `npm:${name}:${ids.join(",") || v.range}`,
    severity: SEV.includes(v.severity) ? v.severity : "moderate",
    title: `${name}: ${titles[0] ?? "vulnerabilita' transitiva"}`,
    description: `Range: ${v.range}. Diretta: ${v.isDirect ? "si" : "no"}. Fix disponibile: ${v.fixAvailable ? (typeof v.fixAvailable === "object" ? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? " (major: richiede approvazione)" : ""}` : "si (npm audit fix)") : "no"}. ${ids.map((i) => `https://github.com/advisories/${i}`).join(" ")}`,
    package_name: name,
    fixed_version: typeof v.fixAvailable === "object" ? v.fixAvailable.version : undefined,
  });
}

// 2. inventario dipendenze e licenze
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = existsSync(join(root, "package-lock.json")) ? JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) : { packages: {} };
const packages = Object.entries(lock.packages ?? {})
  .filter(([p]) => p.startsWith("node_modules/"))
  .map(([p, info]) => ({ name: p.replace(/^.*node_modules\//, ""), version: info.version, license: info.license ?? "UNKNOWN", dev: Boolean(info.dev), integrity: Boolean(info.integrity) }));
const direct = { ...pkg.dependencies, ...pkg.devDependencies };
const unpinned = Object.entries(direct).filter(([, v]) => /[\^~*><]|latest/.test(v));
const licenses = packages.reduce((a, p) => ((a[p.license] = (a[p.license] ?? 0) + 1), a), {});
const COPYLEFT = /(^|[^L])GPL|AGPL|SSPL|EUPL/i;
const riskyLicenses = packages.filter((p) => !p.dev && COPYLEFT.test(p.license));
const noIntegrity = packages.filter((p) => !p.integrity);

// 3. GitHub Actions
const wfDir = join(root, ".github", "workflows");
const actions = [];
const permissions = [];
if (existsSync(wfDir)) {
  for (const f of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x))) {
    const text = readFileSync(join(wfDir, f), "utf8");
    for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      const [ref, version] = m[1].split("@");
      actions.push({ workflow: f, action: ref, ref: version, pinnedSha: /^[0-9a-f]{40}$/.test(version ?? "") });
    }
    const perm = /^permissions:\s*\n((?:\s{2,}.+\n)+)/m.exec(text)?.[1]?.trim().replace(/\s+/g, " ") ?? (/^permissions:\s*(\S+)/m.exec(text)?.[1] ?? "NON DICHIARATI (default del repository)");
    permissions.push({ workflow: f, permissions: perm });
  }
}
for (const a of actions.filter((x) => !x.pinnedSha && !x.action.startsWith("./"))) {
  findings.push({ fingerprint: `actions:${a.workflow}:${a.action}`, severity: "moderate", title: `GitHub Action non fissata a SHA: ${a.action}@${a.ref}`, description: `Workflow ${a.workflow}. Fissare a un commit SHA verificato.` });
}
for (const [name, v] of unpinned) {
  findings.push({ fingerprint: `pin:${name}`, severity: "low", title: `Dipendenza diretta non fissata: ${name}@${v}`, description: "Usare versioni esatte; aggiornamenti via Dependabot con test." });
}
for (const p of riskyLicenses) {
  findings.push({ fingerprint: `license:${p.name}`, severity: "low", title: `Licenza da verificare: ${p.name} (${p.license})`, description: "Licenza copyleft in dipendenza di runtime." });
}

// 4. servizi di terze parti (inventario statico)
const thirdParty = [
  { service: "Supabase (Postgres, Auth) - progetto dedicato", use: "database e autenticazione di Personal OS", data: "dati personali, sonno, alimentazione, allenamenti, agenda; email (Auth)", status: "richiede progetto separato da IronEdge" },
  { service: "Vercel", use: "hosting Next.js", data: "log richieste (senza corpo)", status: "richiede progetto separato; piano Hobby solo uso non commerciale" },
  { service: "GitHub Actions", use: "CI, scansioni, scheduler ogni 15 min, backup (solo repo privato)", data: "codice; nessun dato personale nei log", status: "attivo sul repository" },
  { service: "IronEdge Growth OS", use: "sincronizzazione task (HMAC server-to-server)", data: "in uscita SOLO external_id, stato, versione", status: "richiede patch IronEdge e segreto condiviso" },
  { service: "Google Calendar API (OAuth)", use: "lettura impegni, creazione eventi autorizzati", data: "titoli e orari eventi; refresh token cifrato AES-256-GCM", status: "richiede client OAuth Google" },
  { service: "Telegram Bot API", use: "notifiche (bot dedicato)", data: "testo notifiche (briefing, promemoria)", status: "opzionale, token bot e opt-in" },
  { service: "Anthropic API", use: "assistente AI opzionale per richieste libere", data: "titoli/orari di oggi e memoria, solo con consenso; mai diario alimentare o sonno", status: "disattivato; richiede chiave, budget e consenso" },
  { service: "npm registry", use: "dipendenze", data: "nessuno", status: "attivo in build" },
  { service: "Lucide (lucide-react, ISC)", use: "icone SVG incluse nel bundle", data: "nessuno", status: "dipendenza runtime, 0 sotto-dipendenze" },
];

// 5. output
mkdirSync(outDir, { recursive: true });
const counts = SEV.reduce((a, s) => ((a[s] = findings.filter((f) => f.severity === s).length), a), {});
const inventory = {
  generated_at: new Date().toISOString(),
  node: process.version,
  dependencies: { direct: Object.keys(direct).length, total: packages.length, runtime: packages.filter((p) => !p.dev).length, dev: packages.filter((p) => p.dev).length },
  licenses,
  unpinned_direct: unpinned,
  packages_without_integrity: noIntegrity.map((p) => p.name),
  actions,
  workflow_permissions: permissions,
  third_party: thirdParty,
  npm_audit_metadata: audit.metadata ?? audit.error ?? null,
  findings,
};
writeFileSync(join(outDir, "inventory.json"), JSON.stringify(inventory, null, 2));
const md = [
  `# Report sicurezza Personal OS`,
  ``,
  `Generato: ${inventory.generated_at} · Node ${process.version}`,
  ``,
  `## Sintesi`,
  `- Finding: critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low}, info ${counts.info}`,
  `- Dipendenze: ${inventory.dependencies.direct} dirette, ${inventory.dependencies.total} totali (${inventory.dependencies.runtime} runtime, ${inventory.dependencies.dev} dev)`,
  `- Dipendenze dirette non fissate: ${unpinned.length}`,
  `- Pacchetti senza hash di integrita' nel lockfile: ${noIntegrity.length}`,
  `- GitHub Actions: ${actions.length} riferimenti, ${actions.filter((a) => a.pinnedSha).length} fissati a SHA`,
  ``,
  `## Finding`,
  findings.length ? findings.map((f) => `- **${f.severity}** ${f.title}${f.description ? ` — ${f.description}` : ""}`).join("\n") : "Nessun finding rilevato dagli scanner configurati (non equivale a sicurezza assoluta).",
  ``,
  `## Licenze`,
  Object.entries(licenses).sort((a, b) => b[1] - a[1]).map(([l, n]) => `- ${l}: ${n}`).join("\n"),
  ``,
  `## Permessi workflow`,
  permissions.map((p) => `- ${p.workflow}: ${p.permissions}`).join("\n") || "- nessun workflow",
  ``,
  `## Servizi di terze parti`,
  thirdParty.map((t) => `- **${t.service}** — uso: ${t.use}; dati: ${t.data}; stato: ${t.status}`).join("\n"),
  ``,
].join("\n");
writeFileSync(join(outDir, "report.md"), md);
console.log(md);

// 6. ingest opzionale nel Security Center
const url = process.env.SECURITY_INGEST_URL;
const secret = process.env.SECURITY_INGEST_SECRET;
if (url && secret) {
  const npmFindings = findings.filter((f) => f.fingerprint.startsWith("npm:"));
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ scanner: "npm-audit", complete: !audit.error, findings: npmFindings }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => ({ ok: false, status: e.message }));
  console.log(`Ingest Security Center: ${res.ok ? "ok" : `fallito (${res.status})`}`);
}

const threshold = failOn === "none" ? Infinity : SEV.indexOf(failOn);
const worst = Math.max(-1, ...findings.map((f) => SEV.indexOf(f.severity)));
if (worst >= threshold) {
  console.error(`Soglia superata: finding di severita' >= ${failOn}`);
  process.exit(1);
}
