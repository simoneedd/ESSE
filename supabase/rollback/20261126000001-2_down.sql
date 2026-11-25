-- Rollback completo dello schema Personal OS (migrazioni 20261126000001 e 20261126000002).
-- DISTRUTTIVO: elimina tutti i dati. Eseguire solo con approvazione e dopo un backup verificato.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop table if exists public.%I cascade', t.tablename);
  end loop;
end $$;
drop function if exists public.ensure_profile(), public.mark_notification_read(uuid), public.decide_proposal(uuid, boolean),
  public.delete_my_data(text), public.acquire_job(uuid, text, text, integer), public.finish_job(uuid, public.run_status, text, jsonb),
  public.claim_outbox(text, uuid, integer), public.complete_outbox(uuid, boolean, text), public.purge_expired_data(uuid) cascade;
drop type if exists public.life_area, public.task_status, public.task_source, public.flexibility, public.block_status,
  public.proposal_status, public.meal_slot, public.trading_kind, public.study_kind, public.sync_direction, public.sync_outcome,
  public.outbox_status, public.memory_kind, public.run_status, public.notify_channel cascade;
drop schema if exists app cascade;
