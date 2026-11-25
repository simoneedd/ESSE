# Sicurezza e privacy — audit e controlli

## Audit eseguito (2026-11-26)
| Oggetto | Esito |
|---|---|
| Dipendenze Personal OS (16 dirette, 485 totali) | `npm audit`: 0 vulnerabilità; 0 dipendenze dirette non fissate; stesse versioni esatte e lockfile con hash di IronEdge (già auditato). `npm audit signatures` non verificabile in questo ambiente (download chiavi bloccato dalla rete): eseguito in CI |
| Segreti nel repository | `scripts/secret-scan.mjs`: 0 rilevati; gitleaks sulla storia completa in CI |
| IronEdge Growth OS (lettura del codice, nessuna modifica remota) | RLS forzata, service role solo server, CSP con nonce, redazione log, rate limit, webhook firmati: coerente con docs/SECURITY.md di IronEdge. Osservazioni: rate limit per-istanza (noto), protezione branch assente (GitHub Pro, noto), deploy automatico non attende la CI (noto) |
| Servizi di terze parti | Inventario in `security-reports/inventory.json` (Supabase, Vercel, GitHub Actions, IronEdge, Google Calendar, Telegram, Anthropic, npm, Lucide) con dati scambiati e stato |
| Patch IronEdge | Nessuna nuova dipendenza; superficie: 1 route firmata, 3 funzioni service-role, 1 tabella nonce senza accesso utente |

## Controlli applicativi
| Rischio | Contromisura | Dove |
|---|---|---|
| Accesso ai dati di altri | RLS forzata su 39/39 tabelle, `user_id = auth.uid()`, trigger "stesso proprietario" sui riferimenti, `user_id` immutabile | migrazione 002, `tests/db/rls.test.ts` |
| Tabelle di sistema | sync, outbox, notifiche, report, audit: sola lettura per l'utente; token OAuth, job e findings: nessun accesso | migrazione 002 |
| Dati verso IronEdge | Payload `strict` di 3 campi garantito da trigger e schema; test che verificano l'assenza di altri campi | `protocol.ts`, test e2e/contratto |
| Integrazione S2S | HMAC, nonce monouso, finestra temporale, segreto ≥ 32, https obbligatorio, `redirect: "error"`, timeout | `sync/ironedge.ts` |
| Token Google | AES-256-GCM con AAD legato all'utente, tabella senza privilegi client, PKCE + state in cookie httpOnly, scope minimi | `gcal.ts`, `api/google/*` |
| Prompt injection | Dati come materiale non fidato tra delimitatori sanificati; il modello può solo scegliere azioni predefinite validate dallo stesso schema del parser; nessuna scrittura libera; impegni fissi sempre su approvazione | `assistant/ai.ts` |
| Dati personali all'AI | AI disattivata di default, consenso esplicito, consenso separato per benessere; mai diario alimentare, sonno o note | `assistente/actions.ts` |
| Costi AI | Budget mensile e quota giornaliera verificati su DB prima di ogni chiamata; fallback server-side su rifiuto | `assistant/ai.ts` |
| XSS / CSRF / clickjacking | React escaping, `react/no-danger` (unica eccezione: script tema statico con nonce), CSP nonce + `strict-dynamic`, Server Actions con verifica origine, logout solo POST, `frame-ancestors 'none'` | `proxy.ts` |
| Open redirect | `safeBack` accetta solo percorsi interni | `lib/action.ts` |
| Abuso API | Rate limit su login, assistente, export, cron, ingest, OAuth; limiti di dimensione su input e corpi | varie |
| Log | `redact()` rimuove token, chiavi, JWT, email, telefoni; audit con soli nomi dei campi | `security.ts` |
| Retention | Configurabile (30-3650 giorni) + pulizia automatica; export completo e cancellazione totale dall'utente | `purge_expired_data`, `delete_my_data` |
| Offline | Il service worker non salva pagine né dati | `public/sw.js` |

## Monitoraggio e correzione (protocollo IronEdge, permessi separati)
- `ci.yml`: secret scan, lint, typecheck, test, build, migrazioni su PostgreSQL 17 reale + smoke test.
- `security.yml`: npm audit, firme registry, OSV-Scanner, gitleaks (storia completa) su ogni push e **ogni giorno**; esiti al Security Center via ingest. L'issue pubblica giornaliera è **disattivata se il repository è pubblico** (non si pubblicano vulnerabilità).
- `security-autofix.yml`: `npm audit fix` senza `--force`, rifiuta cambi di major, regressione completa, apre PR, **mai merge**.
- `dependabot.yml` + `dependabot-automerge.yml` (solo patch e solo con `AUTO_MERGE_POLICY=patch`).
- `backup-restore.yml`: dump cifrato + test di restore; **disattivato su repository pubblico** (log e artefatti sarebbero pubblici).
- `rollback.yml`: rollback Vercel manuale con approvazione dell'environment `production`.
- Modifiche ad alto rischio (migrazioni, rotazione segreti, major, distruttive, patch IronEdge): sempre con approvazione.

## Rischi residui (onesti)
- **Il repository `simoneedd/ESSE` è pubblico**: il codice è visibile (nessun segreto o dato è incluso). Raccomandato renderlo privato; in tal caso lo scheduler ogni 15 min consuma ~2.900 min/mese di Actions (oltre i 2.000 gratuiti): portare il cron a 30 min.
- Rate limit per-istanza serverless; protezione branch non disponibile senza GitHub Pro.
- Cifratura a riposo dei dati sanitari affidata a Supabase (disco cifrato); cifratura applicativa solo per i token OAuth.
- Nessuna garanzia di sicurezza assoluta; gli scanner trovano solo vulnerabilità note.
