#!/usr/bin/env node
/**
 * Scansione segreti locale e veloce (complementare a gitleaks in CI).
 * Esclude node_modules, .next, file binari e .env.example (solo segnaposto).
 * Esce con codice 1 se trova possibili segreti.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "security-reports", ".vercel", "coverage"]);
const SKIP_FILES = new Set([".env.example", "package-lock.json"]);
const MAX = 1_000_000;
const RULES = [
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["Anthropic API key", /\bsk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{20,}/],
  ["JWT (possibile service role)", /\beyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Chiave privata", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ["Postgres URL con password", /postgres(ql)?:\/\/[^:\s/]+:[^@\s]{6,}@/],
  ["Assegnazione segreto", /(SERVICE_ROLE_KEY|CRON_SECRET|WEBHOOK_SECRET|INGEST_SECRET|API_KEY|BOT_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_\-.:]{24,}/],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (!SKIP_FILES.has(name) && st.size <= MAX && !/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|zip|gz)$/i.test(name)) {
      const text = readFileSync(p, "utf8");
      if (text.includes("\u0000")) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (/secret-scan:\s*ignore/.test(line)) return;
        for (const [label, re] of RULES) if (re.test(line)) hits.push(`${relative(root, p)}:${i + 1} ${label}`);
      });
    }
  }
}
function scanFile(p) {
  const name = p.split(/[\\/]/).pop();
  if (SKIP_FILES.has(name) || /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|zip|gz)$/i.test(name)) return;
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (!st.isFile() || st.size > MAX) return;
  const text = readFileSync(p, "utf8");
  if (text.includes("\u0000")) return;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/secret-scan:\s*ignore/.test(line)) return;
    for (const [label, re] of RULES) if (re.test(line)) hits.push(`${relative(root, p)}:${i + 1} ${label}`);
  });
}

// Con git disponibile si analizzano solo i file pubblicabili (tracciati o nuovi non ignorati):
// i file locali ignorati come .env.local devono contenere segreti e non vengono mai committati.
let files = null;
try {
  files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch {
  files = null;
}
if (files) files.forEach((f) => scanFile(join(root, f)));
else walk(root);
if (hits.length) {
  console.error(`Possibili segreti trovati (${hits.length}):\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("Nessun segreto rilevato.");
