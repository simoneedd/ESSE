import type { LocalSyncedTask, SyncStore } from "@/lib/sync/ironedge";
import type { Db } from "../db/harness";

/** SyncStore su PGlite (stesse tabelle/funzioni SQL della produzione, esecuzione come service role). */
export function pgliteSyncStore(db: Db, userId: string, timeZone = "Europe/Rome"): SyncStore {
  const q = <T>(sql: string, params: unknown[] = []) => db.asService(async () => (await db.query<T>(sql, params)).rows);
  return {
    timeZone,
    async getCursor() {
      return (await q<{ cursor: string | null }>("select cursor from public.integration_state where user_id = $1 and provider = 'ironedge'", [userId]))[0]?.cursor ?? null;
    },
    async saveCursor(cursor, ok, error) {
      await q(
        `insert into public.integration_state (user_id, provider, enabled, cursor, last_success_at, last_error, consecutive_failures)
         values ($1, 'ironedge', true, $2, case when $3 then now() end, $4, case when $3 then 0 else 1 end)
         on conflict (user_id, provider) do update set cursor = excluded.cursor,
           last_success_at = coalesce(excluded.last_success_at, integration_state.last_success_at),
           last_error = excluded.last_error,
           consecutive_failures = case when $3 then 0 else integration_state.consecutive_failures + 1 end`,
        [userId, cursor, ok, ok ? null : (error ?? "errore")],
      );
    },
    async findByExternalIds(ids) {
      if (!ids.length) return [];
      return q<LocalSyncedTask>(
        `select id, external_id, external_group_id, external_version, external_payload_hash, status, local_dirty, due_at::text
           from public.tasks where user_id = $1 and source = 'ironedge' and external_id = any($2)`,
        [userId, ids],
      );
    },
    async dependencyCandidates(groupIds) {
      if (!groupIds.length) return [];
      return q("select id, external_group_id, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') due_at from public.tasks where user_id = $1 and external_group_id = any($2)", [userId, groupIds]);
    },
    async insertTask(f) {
      try {
        const rows = await q<{ id: string }>(
          `insert into public.tasks (user_id, title, description, priority, due_at, estimated_minutes, status, category, completed_at,
             external_id, external_group_id, external_url, external_version, external_payload_hash, area, source, flexibility, depends_on, last_synced_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ironedge','ironedge','flexible',$15, now()) returning id`,
          [userId, f.title, f.description, f.priority, f.due_at, f.estimated_minutes, f.status, f.category, f.completed_at, f.external_id, f.external_group_id, f.external_url, f.external_version, f.external_payload_hash, f.depends_on],
        );
        return rows[0];
      } catch (e) {
        if (/duplicate key/.test(String(e))) return { duplicate: true as const };
        throw e;
      }
    },
    async updateTask(id, fields) {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
      await q(`update public.tasks set ${sets} where id = $1 and user_id = $2`, [id, userId, ...entries.map(([, v]) => v)]);
    },
    async supersedeOutbox(taskId) {
      await q("update public.sync_outbox set status = 'done', last_error = 'superata' where entity_id = $1 and status in ('pending','failed')", [taskId]);
    },
    async claimOutbox(limit) {
      return q("select id, entity_id, payload, idempotency_key, attempts from public.claim_outbox('ironedge', $1, $2)", [userId, limit]);
    },
    async completeOutbox(id, ok, error) {
      return (await q<{ s: string }>("select public.complete_outbox($1, $2, $3) s", [id, ok, error ?? null]))[0]?.s ?? null;
    },
    async log(e) {
      await q(
        "insert into public.sync_log (user_id, provider, direction, outcome, entity_id, external_id, detail, stats) values ($1, 'ironedge', $2, $3, $4, $5, $6, $7)",
        [userId, e.direction, e.outcome, e.entity_id ?? null, e.external_id ?? null, e.detail ?? null, JSON.stringify(e.stats ?? {})],
      );
    },
  };
}
