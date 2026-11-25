# Configurazione (richiede le tue credenziali e autorizzazioni)

Ogni passo è gratuito salvo dove indicato. Nessun servizio a pagamento è stato attivato.

1. **Supabase (nuovo progetto dedicato, Free)** — regione Francoforte. Non riutilizzare il progetto IronEdge.
   - SQL editor: esegui in ordine `supabase/migrations/*.sql`, poi `supabase/tests/smoke.sql` (deve stampare `smoke ok`; attenzione: lo smoke test usa ruoli e righe temporanee, eseguilo prima di inserire dati).
   - Auth: **disattiva le registrazioni pubbliche** (Authentication › Sign In / Providers › "Allow new users to sign up" = off), crea il tuo utente a mano, abilita MFA se disponibile. Copia il suo UUID in `OWNER_USER_ID`.
   - Rate limit Auth e "Enforce SSL" attivi; API GraphQL disattivata.
2. **Vercel (progetto separato, Hobby: uso personale)** — collega il repository, regione `fra1`, imposta le variabili di `.env.example` (segreti solo server). Abilita Deployment Protection sulle anteprime.
3. **GitHub** — secret: `CRON_SECRET`, `SECURITY_INGEST_SECRET`; variabile: `APP_URL`. Facoltativi: `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` (backup solo se il repository è privato), `VERCEL_TOKEN/ORG_ID/PROJECT_ID` (rollback).
4. **IronEdge** — vedi [INTEGRATION-IRONEDGE.md](INTEGRATION-IRONEDGE.md) (patch + migrazione + segreto condiviso).
5. **Google Calendar (facoltativo)** — Google Cloud Console: progetto, abilita "Google Calendar API", schermata consenso (tipo "Esterno", stato "Testing" con te come utente di test: nessuna verifica Google necessaria per uso personale), client OAuth "Applicazione web" con redirect `https://<APP_URL>/api/google/callback`. Imposta `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`). Poi Impostazioni › Integrazioni › Collega, e indica gli ID dei 6 calendari (Personale, Marketing, Trading, IronEdge, Palestra, Studio) con lettura/scrittura per area. Nota: in stato "Testing" Google fa scadere il refresh token dopo 7 giorni; per evitarlo pubblica l'app (uso personale, scope sensibile → possibile verifica).
6. **Telegram (facoltativo)** — crea un bot **dedicato** con @BotFather (non riutilizzare quello IronEdge), imposta `TELEGRAM_BOT_TOKEN`, scrivi al bot e inserisci il tuo chat ID in Impostazioni con opt-in.
7. **AI (facoltativo, a pagamento a consumo)** — richiede la tua autorizzazione economica: `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MONTHLY_BUDGET_USD` (es. 5), poi consenso in Impostazioni › Privacy.

## Verifica dopo il deploy
`/api/health` → 200 · `/` senza sessione → `/login` · `POST /api/cron` senza bearer → 401 · Impostazioni mostra lo stato reale delle integrazioni.
