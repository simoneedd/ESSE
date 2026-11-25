import type { SupabaseClient } from "@supabase/supabase-js";
import { redact } from "../security";
import type { LocalSyncedTask, LogEntry, OutboxItem, SyncStore, SyncedFields } from "./ironedge";

/** Implementazione di SyncStore su Supabase (service role, sempre filtrata per user_id). */
export function supabaseSyncStore(admin: SupabaseClient, userId: string, timeZone: string): SyncStore {
  const must = <T>(r: { data: T; error: { message: string; code?: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  return {
    timeZone,
    async getCursor() {
      const r = await admin.from("integration_state").select("cursor").eq("user_id", userId).eq("provider", "ironedge").maybeSingle();
      return (must(r) as { cursor: string | null } | null)?.cursor ?? null;
    },
    async saveCursor(cursor, ok, error) {
      const { data: prev } = await admin.from("integration_state").select("consecutive_failures").eq("user_id", userId).eq("provider", "ironedge").maybeSingle();
      const failures = ok ? 0 : ((prev as { consecutive_failures: number } | null)?.consecutive_failures ?? 0) + 1;
      must(
        await admin.from("integration_state").upsert(
          {
            user_id: userId,
            provider: "ironedge",
            enabled: true,
            cursor,
            ...(ok ? { last_success_at: new Date().toISOString(), last_error: null } : { last_error: redact(error ?? "errore", 300) }),
            consecutive_failures: failures,
          },
          { onConflict: "user_id,provider" },
        ),
      );
    },
    async findByExternalIds(ids) {
      if (!ids.length) return [];
      const r = await admin
        .from("tasks")
        .select("id, external_id, external_group_id, external_version, external_payload_hash, status, local_dirty, due_at")
        .eq("user_id", userId)
        .eq("source", "ironedge")
        .in("external_id", ids);
      return must(r) as LocalSyncedTask[];
    },
    async dependencyCandidates(groupIds) {
      if (!groupIds.length) return [];
      const r = await admin.from("tasks").select("id, external_group_id, due_at").eq("user_id", userId).eq("source", "ironedge").in("external_group_id", groupIds);
      return must(r) as { id: string; external_group_id: string | null; due_at: string | null }[];
    },
    async insertTask(fields: SyncedFields & { depends_on: string[] }) {
      const r = await admin
        .from("tasks")
        .insert({ ...fields, user_id: userId, last_synced_at: new Date().toISOString() })
        .select("id")
        .single();
      if (r.error?.code === "23505") return { duplicate: true as const };
      return must(r) as { id: string };
    },
    async updateTask(id, fields) {
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      must(await admin.from("tasks").update(clean).eq("id", id).eq("user_id", userId));
    },
    async supersedeOutbox(taskId) {
      must(
        await admin
          .from("sync_outbox")
          .update({ status: "done", last_error: "superata: IronEdge autorevole" })
          .eq("user_id", userId)
          .eq("entity_id", taskId)
          .in("status", ["pending", "failed"]),
      );
    },
    async claimOutbox(limit) {
      const r = await admin.rpc("claim_outbox", { p_provider: "ironedge", p_user: userId, p_limit: limit });
      return (must(r) ?? []) as OutboxItem[];
    },
    async completeOutbox(id, ok, error) {
      const r = await admin.rpc("complete_outbox", { p_id: id, p_ok: ok, p_error: error ? redact(error, 300) : null });
      return must(r) as string | null;
    },
    async log(entry: LogEntry) {
      await admin.from("sync_log").insert({
        user_id: userId,
        provider: "ironedge",
        direction: entry.direction,
        outcome: entry.outcome,
        entity_id: entry.entity_id ?? null,
        external_id: entry.external_id ?? null,
        detail: entry.detail ? redact(entry.detail, 400) : null,
        stats: entry.stats ?? {},
      });
    },
  };
}
