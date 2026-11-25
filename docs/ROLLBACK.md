# Rollback

- **Applicazione**: Vercel › Deployments › deployment precedente › "Promote to Production", oppure workflow `rollback.yml` (approvazione), oppure `git revert` e push.
- **Database Personal OS**: `supabase/rollback/20261126000001-2_down.sql` (distruttivo, solo dopo backup/export); ciclo up/down/up testato in `tests/db/rollback.test.ts`.
- **Integrazione IronEdge**: disattivazione immediata rimuovendo `PERSONAL_OS_SHARED_SECRET` in IronEdge (l'API risponde 503) o `IRONEDGE_SHARED_SECRET` in Personal OS (la sync si ferma, l'outbox conserva le modifiche). Rollback schema: `supabase/rollback/20261126000001_down.sql` nel repository IronEdge (testato nel ciclo up/down/up di IronEdge). Checkpoint locale del clone IronEdge: tag `checkpoint/pre-personal-os-integration`.
- **Google Calendar**: Impostazioni › Integrazioni › Sospendi; revoca completa da https://myaccount.google.com/permissions.
