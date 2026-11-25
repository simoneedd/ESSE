# Patch per IronEdge Growth OS

`0001-personal-os-integration.patch` — generata dal branch locale `feature/personal-os-integration` (base `main` e53f9ec). **Non applicata al repository remoto**: richiede la tua approvazione (modifica del gestionale in produzione).

Contenuto: migrazione additiva + rollback, protocollo condiviso, handler `src/lib/personal-os.ts`, route `/api/integrations/personal-os`, variabili d'ambiente, esclusione della route dal proxy di sessione, 17 test nuovi, aggiornamento dei conteggi tabelle nei test esistenti (27 → 28).

Applicazione: vedi [docs/INTEGRATION-IRONEDGE.md](../../docs/INTEGRATION-IRONEDGE.md).
