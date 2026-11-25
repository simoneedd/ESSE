# Integrazione Personal OS ↔ IronEdge Growth OS

## Contratto (`src/lib/integration/protocol.ts`, identico in IronEdge come `src/lib/personal-os-protocol.ts`)
- **Autenticazione server-to-server**: HMAC-SHA256 su `pos-v1\nMETODO\npath?query\ntimestamp\nnonce\nsha256(corpo)`; header `x-pos-version`, `x-pos-timestamp`, `x-pos-nonce`, `x-pos-signature`. Finestra ±300 s, nonce monouso salvato in IronEdge (`integration_nonces`, 10 min).
- **Credenziali solo lato server**: `IRONEDGE_SHARED_SECRET` (Personal OS) = `PERSONAL_OS_SHARED_SECRET` (IronEdge), ≥ 32 caratteri, mai `NEXT_PUBLIC_`.
- **Permessi minimi**: un solo workspace (`PERSONAL_OS_WORKSPACE_ID`); lettura occorrenze in una finestra ≤ 62 giorni; scrittura **solo** stato `open`/`done` firmata dall'attore `PERSONAL_OS_ACTOR_USER_ID` (deve essere owner/editor, verificato a ogni richiesta). Funzioni SQL eseguibili solo dal service role.
- **Minimizzazione**: Personal OS invia esclusivamente `{external_id, status, base_version}`; lo schema è `strict()` su entrambi i lati: qualsiasi campo aggiuntivo (es. dati personali, sonno, alimentazione) viene rifiutato con 400.

## Endpoint IronEdge `/api/integrations/personal-os`
| Metodo | Parametri | Risposta |
|---|---|---|
| GET | `since` (cursore ISO), `from`, `to` (YYYY-MM-DD), `limit` ≤ 500 | `items[]` (occorrenza, task modello, titolo, descrizione, priorità, scadenza, data, durata, stato, categoria, dipendenze, completamento, versione, attiva, link) + `next_cursor`, `has_more` |
| POST | `{external_id, status, base_version}` + header `Idempotency-Key` | `applied` / `noop` (idempotente) / `conflict` (409, stato IronEdge) / `not_found` (404) |

## Campi sincronizzati
Titolo, descrizione, priorità, scadenza, durata stimata, stato, categoria, dipendenze (risolte in id locali), data di completamento, collegamento alla task originale (`/impostazioni#task-<id>` in IronEdge).

## Regole
- **Identificativi**: `occ:<uuid>`, vincolo UNIQUE `(user_id, source, external_id)` → nessun duplicato, anche con sync concorrenti (gestito come `duplicate` nello storico).
- **Fonte autorevole**: i campi sincronizzati sono bloccati da trigger in Personal OS; l'utente può solo completare/riaprire e impostare preferenze di pianificazione. Le task IronEdge non si eliminano da Personal OS.
- **Conflitti**: se l'occorrenza è cambiata in IronEdge dopo la versione nota (`base_version`), IronEdge non scrive e restituisce il proprio stato; Personal OS lo applica e registra `conflict`.
- **Retry**: outbox con backoff esponenziale 1, 2, 4… min (max 6 h), dead-letter dopo 8 tentativi; errori 5xx/429/rete ritentati, 4xx no.
- **Storico**: `sync_log` (id, esito, conteggi; nessun contenuto personale), visibile in Impostazioni.

## Attivazione (richiede la tua approvazione: modifica di IronEdge)
1. In IronEdge: `git checkout -b feature/personal-os-integration && git am < integrations/ironedge/0001-personal-os-integration.patch` (checkpoint consigliato: tag prima dell'applicazione).
2. `npm run check` in IronEdge (96 test attesi), poi PR e merge con controlli verdi.
3. Applica la migrazione `20261126000001_personal_os_integration.sql` al progetto Supabase di IronEdge (rollback: `supabase/rollback/20261126000001_down.sql`).
4. Genera il segreto (`openssl rand -base64 48`) e impostalo in Vercel IronEdge (`PERSONAL_OS_SHARED_SECRET`, `PERSONAL_OS_WORKSPACE_ID`, `PERSONAL_OS_ACTOR_USER_ID`) e in Personal OS (`IRONEDGE_BASE_URL`, `IRONEDGE_SHARED_SECRET`).

## Verifiche eseguite
- IronEdge con la patch: 96/96 test (79 preesistenti invariati + 17 nuovi), lint, typecheck e build OK.
- Personal OS: test end-to-end con server simulato che verifica firme reali; **test di contratto** che esegue l'handler reale di IronEdge e le sue migrazioni reali (PGlite): pull, completamento → occorrenza `done` con audit, modifica in IronEdge → Personal OS, firma errata → 401.
