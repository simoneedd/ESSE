# Personal OS (Esse) — assistente esecutivo personale

Applicazione indipendente (Next.js 16 + TypeScript + Supabase dedicato) per pianificare vita personale e professionale, integrata con **IronEdge Growth OS** tramite un'API server-to-server firmata.

## Stato al 2026-11-26

| Area | Stato |
|---|---|
| Schema Postgres dedicato (39 tabelle), RLS forzata per utente, trigger di integrità | Implementato e testato (PGlite + smoke/rollback) |
| Smart Scheduler deterministico (sonno protetto, fissi vs flessibili, dipendenze, pause, margine, sovraccarico, ripianificazione) | Implementato e testato |
| Sincronizzazione bidirezionale IronEdge (pull incrementale, outbox con retry/backoff, conflitti, storico) | Implementata; test end-to-end e **test di contratto contro il codice reale di IronEdge** superati. **Non attiva** finché la patch IronEdge non viene applicata e i segreti configurati |
| Interfaccia (dashboard Bento, timeline, calendario settimanale, task, marketing multi-cliente, trading, studio, palestra, alimentazione, sonno, abitudini, report, impostazioni, sicurezza) | Implementata, build di produzione OK; verificata visivamente su anteprima (chiaro/scuro/mobile). Non ancora provata su un database Supabase reale |
| Assistente conversazionale | Comandi in italiano **funzionanti senza AI** (gratuiti); livello AI Anthropic opzionale, **disattivato** (nessuna chiave/budget) |
| Google Calendar (OAuth + PKCE, calendari per area, anti-loop) | Implementato; **non collegato** (serve client OAuth Google) |
| Notifiche: in-app, Telegram (bot dedicato) | In-app sempre; Telegram **non collegato**. Web Push non implementato (vedi limiti) |
| Automazioni cloud (briefing, promemoria, revisione serale, report settimanale/mensile, sync) | Implementate (`/api/cron` + GitHub Actions ogni 15 min); **inattive** finché non configurate |
| PWA installabile | Manifest, icone, service worker senza cache di dati personali |
| Sicurezza: scansioni giornaliere, autofix controllato, backup, rollback | Workflow inclusi (protocollo IronEdge riutilizzato) |

Nulla di quanto sopra è online: Personal OS **non è ancora deployato** (servono le tue credenziali: vedi [docs/SETUP.md](docs/SETUP.md)).

## Comandi

```bash
npm ci
npm run dev            # http://localhost:3000 (senza Supabase mostra /setup)
npm run check          # lint + typecheck + test + build
npm run security:audit # inventario supply chain + npm audit -> security-reports/
npm run security:secrets
```

## Struttura

- `src/lib/scheduler/engine.ts` — motore di pianificazione (puro, testato)
- `src/lib/sync/` — sincronizzazione IronEdge · `src/lib/integration/protocol.ts` — contratto firmato condiviso
- `src/lib/assistant/` — comandi in italiano, esecuzione sicura, livello AI con guardrail
- `src/lib/gcal*.ts` — Google Calendar · `src/lib/jobs.ts` — automazioni cloud
- `src/app/(app)/*` — moduli UI · `src/app/api/*` — cron, OAuth Google, export, ingest sicurezza, health
- `supabase/` — migrazioni, rollback, smoke test · `tests/` — unit, DB/RLS, e2e sync, contratto IronEdge
- `integrations/ironedge/` — patch per IronEdge Growth OS (da applicare con la tua approvazione)
- [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/INTEGRATION-IRONEDGE.md](docs/INTEGRATION-IRONEDGE.md) · [docs/SETUP.md](docs/SETUP.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) · [docs/COSTS.md](docs/COSTS.md) · [docs/ROLLBACK.md](docs/ROLLBACK.md)
