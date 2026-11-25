# Architettura e analisi di IronEdge Growth OS

## 1. Analisi del sistema esistente (IronEdge Growth OS, commit e53f9ec)
| Aspetto | Rilevato | Conseguenza per Personal OS |
|---|---|---|
| Stack | Next.js 16, React 19, TypeScript, Supabase (Postgres + Auth), Vercel fra1, Zod, Anthropic SDK | Stesso stack e **stesse versioni esatte** (lockfile riutilizzato, già auditato): nessuna nuova dipendenza runtime |
| Task manager | `tasks` = modelli (ricorrenza none/daily/weekly) + `task_occurrences` = istanze giornaliere (open/done/skipped), generate in modo idempotente; completamento via `set_occurrence_status` | L'unità sincronizzata è l'**occorrenza** (`external_id = occ:<uuid>`), con link al modello (`external_group_id`) |
| Campi mancanti | priorità, durata stimata, categoria, dipendenze **non esistono** in IronEdge | Migrazione **additiva** con colonne opzionali (NULL = non indicato): nessun impatto sul codice esistente |
| API | Solo route interne (cron, webhook Telegram, ingest sicurezza, export, health, contesto assistente); nessuna API per terzi | Nuova route `/api/integrations/personal-os` firmata HMAC |
| Auth | Supabase Auth (password + magic link), cookie httpOnly, multi-workspace con ruoli owner/editor/analyst, RLS forzata su 25 tabelle | Integrazione limitata a **un** workspace e **un** attore owner/editor configurati via env |
| Automazioni | GitHub Actions orario → `/api/cron` (Bearer), lock idempotente `acquire_job` | Stesso schema in Personal OS (ogni 15 min) con job per utente |
| AI | Anthropic opzionale, disattivata di default, budget mensile e quota giornaliera su DB, nessun tool, dati delimitati | Stesse protezioni + strumento unico che sceglie solo tra azioni predefinite validate |
| Cybersecurity | CSP con nonce, redazione log, rate limit, gitleaks, OSV, npm audit, firme registry, Actions fissate a SHA, autofix senza `--force`, backup cifrato, rollback | Protocollo **riutilizzato** (script e workflow), con segreti e permessi separati |

Funzionalità non ricostruite: task manager, ricorrenze, gestione contenuti/Telegram di IronEdge. Personal OS legge le task IronEdge e ne aggiorna solo lo stato.

## 2. Architettura
```
Browser (PWA) ──cookie httpOnly──► Personal OS (Next.js, Vercel)
                                    ├─ Supabase DEDICATO (RLS per utente, 39 tabelle)
                                    ├─ IronEdge Growth OS  ◄─ HMAC-SHA256, nonce, ±300 s, permessi minimi
                                    ├─ Google Calendar API ◄─ OAuth 2.0 + PKCE, token cifrato AES-256-GCM
                                    ├─ Telegram Bot API (bot dedicato, opzionale)
                                    └─ Anthropic API (opzionale, consenso + budget)
GitHub Actions ── Bearer CRON_SECRET ──► /api/cron (ogni 15 min): sync, promemoria, briefing, revisioni, report
```

## 3. Flussi principali
- **Pianificazione**: `loadPlanInput` (eventi, sessioni trading fisse, allenamenti, task, pasti dal piano, sonno della notte) → `planDay` (puro) → `savePlan` (sostituisce solo blocchi "planned"; conflitti e rinvii non autorizzati diventano `plan_proposals`).
- **Sync IronEdge**: ogni ciclo prima *push* (outbox) poi *pull* (cursore). Dettagli in [INTEGRATION-IRONEDGE.md](INTEGRATION-IRONEDGE.md).
- **Assistente**: parser deterministico italiano → `executeIntent`; se non riconosciuto e AI attiva+consentita → modello con strumento unico → stesso `executeIntent`.
- **Approvazioni**: modifiche a eventi fissi/riunioni/esterni mai automatiche; `decide_proposal` (RPC con audit).

## 4. Decisioni
| Decisione | Motivo |
|---|---|
| Repository e DB separati | Isolamento di dati sanitari/alimentari; richiesto dalla specifica |
| Motore deterministico + AI opzionale | Funziona a costo zero, testabile, nessuna "allucinazione" nell'agenda |
| Outbox transazionale via trigger | Nessuna modifica locale persa; payload minimo garantito dal DB |
| IronEdge autorevole | Conflitti risolti a favore di IronEdge, registrati nello storico |
| Nessuna cache offline dei dati | Privacy su dispositivi condivisi o smarriti |
