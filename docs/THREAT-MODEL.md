# Threat model (STRIDE)

Asset: agenda, dati di sonno/alimentazione/allenamento, clienti e tempi, token Google, segreto IronEdge, budget AI.
Confini: Browser↔Personal OS · Personal OS↔Supabase · Personal OS↔IronEdge · Personal OS↔Google/Telegram/Anthropic · GitHub Actions→/api/cron.

| Minaccia | Scenario | Mitigazione | Residuo |
|---|---|---|---|
| Spoofing | Chiamata falsa a IronEdge | HMAC + nonce + finestra 300 s + attore verificato | Furto del segreto → ruotarlo in entrambe le app |
| Spoofing | Cron non autorizzato | Bearer a tempo costante, rate limit, job idempotenti | Basso |
| Tampering | Personal OS altera titoli/scadenze IronEdge | Trigger blocca campi sincronizzati; API accetta solo stato | — |
| Tampering | Sync circolare Google | Marcatura `pos_origin`/`pos_id`, import salta eventi propri, ricerca per `pos_id` prima di creare | — |
| Repudiation | Approvazioni non tracciate | `audit_events` per decisioni e collegamenti | Letture non registrate |
| Info disclosure | Dati sanitari a IronEdge | Contratto a 3 campi, schema strict, DB separati | — |
| Info disclosure | Dati all'AI | Consenso, minimizzazione, AI spenta di default | Titoli possono contenere info sensibili |
| Info disclosure | Repo pubblico | Nessun segreto, backup/issue disattivati su repo pubblico, log senza dati | Codice visibile |
| DoS | Flood su assistente/export | Rate limit, budget AI su DB | Per-istanza |
| Elevation | Utente scrive tabelle di sistema | Privilegi revocati + RLS | — |
| Prompt injection | Titolo task con istruzioni | Delimitatori sanificati, azioni predefinite, approvazione per fissi | Risposte AI testuali possono essere errate ("verifica prima di agire") |
| Deletion | Eliminazione involontaria di eventi | Personal OS non elimina eventi Google né riunioni senza conferma; task IronEdge non eliminabili | — |
