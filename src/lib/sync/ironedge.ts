/**
 * Sincronizzazione bidirezionale Personal OS <-> IronEdge Growth OS.
 *
 * - IronEdge e' la fonte AUTOREVOLE delle proprie task: in pull i campi sincronizzati vengono
 *   sempre sovrascritti con i valori remoti; in caso di conflitto vince IronEdge.
 * - Personal OS invia SOLO cambi di stato (open/done) tramite outbox transazionale con retry
 *   e backoff esponenziale (vedi claim_outbox / complete_outbox in SQL).
 * - Identificativi univoci: external_id = "occ:<uuid occorrenza IronEdge>", vincolo UNIQUE
 *   (user_id, source, external_id) -> nessun duplicato anche con sync concorrenti.
 * - Storico: ogni operazione scrive in sync_log (id ed esiti, nessun contenuto personale).
 */
import { createHash } from "node:crypto";
import {
  HEADER,
  listResponseSchema,
  remoteTaskSchema,
  signedHeaders,
  statusResponseSchema,
  statusUpdateSchema,
  type RemoteTask,
  type StatusResponse,
  type StatusUpdate,
} from "../integration/protocol";
import { addDays, zonedToUtc } from "../time";

// ---------------------------------------------------------------------------
// Client HTTP firmato
// ---------------------------------------------------------------------------
export class IronEdgeError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

export type IronEdgeClient = {
  list(params: { since: string | null; from: string; to: string; limit?: number }): Promise<ReturnType<typeof listResponseSchema.parse>>;
  setStatus(update: StatusUpdate, idempotencyKey: string): Promise<StatusResponse>;
};

const PATH = "/api/integrations/personal-os";

export function createIronEdgeClient(baseUrl: string, secret: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): IronEdgeClient {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error("IRONEDGE_BASE_URL deve usare https");
  }
  async function call(method: "GET" | "POST", query: URLSearchParams | null, body: string, extra: Record<string, string> = {}) {
    const url = new URL(PATH, base);
    if (query) url.search = query.toString();
    const path = url.pathname + url.search;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { "content-type": "application/json", ...signedHeaders(secret, method, path, body, now()), ...extra },
        body: method === "GET" ? undefined : body,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
    } catch (e) {
      throw new IronEdgeError(`Rete non raggiungibile: ${(e as Error).name}`, true);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* risposta non JSON */
    }
    return { status: res.status, json };
  }
  return {
    async list({ since, from, to, limit = 200 }) {
      const q = new URLSearchParams({ from, to, limit: String(limit) });
      if (since) q.set("since", since);
      const r = await call("GET", q, "");
      if (r.status !== 200) throw new IronEdgeError(`IronEdge list HTTP ${r.status}`, r.status >= 500 || r.status === 429, r.status);
      const parsed = listResponseSchema.safeParse(r.json);
      if (!parsed.success) throw new IronEdgeError("Risposta IronEdge non conforme al contratto", false, r.status);
      return parsed.data;
    },
    async setStatus(update, idempotencyKey) {
      const body = JSON.stringify(statusUpdateSchema.parse(update)); // strict: nessun campo extra esce
      const r = await call("POST", null, body, { [HEADER.idempotency]: idempotencyKey });
      if ([200, 404, 409].includes(r.status)) {
        const parsed = statusResponseSchema.safeParse(r.json);
        if (!parsed.success) throw new IronEdgeError("Risposta IronEdge non conforme al contratto", false, r.status);
        return parsed.data;
      }
      throw new IronEdgeError(`IronEdge setStatus HTTP ${r.status}`, r.status >= 500 || r.status === 429, r.status);
    },
  };
}

// ---------------------------------------------------------------------------
// Mappatura e decisioni (funzioni pure)
// ---------------------------------------------------------------------------
export type LocalSyncedTask = {
  id: string;
  external_id: string;
  external_group_id: string | null;
  external_version: string | null;
  external_payload_hash: string | null;
  status: "todo" | "in_progress" | "done" | "skipped" | "cancelled";
  local_dirty: boolean;
  due_at: string | null;
};

export type SyncedFields = {
  title: string;
  description: string | null;
  priority: number;
  due_at: string;
  estimated_minutes: number | null;
  status: LocalSyncedTask["status"];
  category: string | null;
  completed_at: string | null;
  external_id: string;
  external_group_id: string;
  external_url: string | null;
  external_version: string;
  external_payload_hash: string;
  area: "ironedge";
  source: "ironedge";
  flexibility: "flexible";
};

export function payloadHash(r: RemoteTask): string {
  const { version: _v, url: _u, ...rest } = r;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 32);
}

export function mapRemoteStatus(r: RemoteTask): LocalSyncedTask["status"] {
  if (!r.task_active && r.status === "open") return "cancelled";
  return r.status === "done" ? "done" : r.status === "skipped" ? "skipped" : "todo";
}

export function mapRemote(r: RemoteTask, timeZone: string): SyncedFields {
  const dueDate = r.due_date ?? r.occurrence_date;
  return {
    title: r.title,
    description: r.description,
    priority: r.priority ?? 3,
    due_at: zonedToUtc(dueDate, "23:59", timeZone).toISOString(),
    estimated_minutes: r.estimated_minutes,
    status: mapRemoteStatus(r),
    category: r.category,
    completed_at: r.status === "done" ? (r.completed_at ?? new Date().toISOString()) : null,
    external_id: `occ:${r.occurrence_id}`,
    external_group_id: r.task_id,
    external_url: r.url.startsWith("https://") ? r.url : null,
    external_version: r.version,
    external_payload_hash: payloadHash(r),
    area: "ironedge",
    source: "ironedge",
    flexibility: "flexible",
  };
}

export type PullDecision =
  | { action: "insert"; fields: SyncedFields }
  | { action: "update"; id: string; fields: SyncedFields; conflict: boolean; supersedeOutbox: boolean }
  | { action: "update_metadata"; id: string; fields: Omit<SyncedFields, "status" | "completed_at"> }
  | { action: "skip"; id: string; reason: "unchanged" | "duplicate" };

/**
 * Regole:
 *  - nessun record locale -> insert;
 *  - stessa versione e stesso hash -> skip (idempotente, nessun duplicato);
 *  - modifica locale in attesa (local_dirty):
 *      versione remota invariata -> aggiorna solo metadati, lo stato locale verra' inviato;
 *      versione remota cambiata -> CONFLITTO: vince IronEdge, outbox superata;
 *  - altrimenti -> update completo con i valori remoti.
 */
export function decidePull(remote: RemoteTask, local: LocalSyncedTask | undefined, timeZone: string): PullDecision {
  const fields = mapRemote(remote, timeZone);
  if (!local) return { action: "insert", fields };
  if (local.external_version === fields.external_version && local.external_payload_hash === fields.external_payload_hash) {
    return { action: "skip", id: local.id, reason: "unchanged" };
  }
  if (local.local_dirty) {
    if (local.external_version === fields.external_version) {
      const { status: _s, completed_at: _c, ...meta } = fields;
      return { action: "update_metadata", id: local.id, fields: meta };
    }
    const localWants = local.status === "done" ? "done" : "open";
    const remoteIs = remote.status === "done" ? "done" : "open";
    return { action: "update", id: local.id, fields, conflict: localWants !== remoteIs, supersedeOutbox: true };
  }
  return { action: "update", id: local.id, fields, conflict: false, supersedeOutbox: false };
}

/** Risolve le dipendenze IronEdge (id task modello) in id locali della stessa giornata o precedente. */
export function resolveDependencies(
  depends: string[],
  dueAt: string,
  candidates: { id: string; external_group_id: string | null; due_at: string | null }[],
): string[] {
  const out: string[] = [];
  for (const dep of depends) {
    const best = candidates
      .filter((c) => c.external_group_id === dep && c.due_at && c.due_at <= dueAt)
      .sort((a, b) => (b.due_at ?? "").localeCompare(a.due_at ?? ""))[0];
    if (best) out.push(best.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrazione (store astratto: Supabase in produzione, memoria nei test)
// ---------------------------------------------------------------------------
export type OutboxItem = { id: string; entity_id: string; payload: unknown; idempotency_key: string; attempts: number };

export type LogEntry = {
  direction: "pull" | "push";
  outcome: "ok" | "conflict" | "error" | "skipped" | "duplicate";
  entity_id?: string | null;
  external_id?: string | null;
  detail?: string | null;
  stats?: Record<string, unknown>;
};

export interface SyncStore {
  timeZone: string;
  getCursor(): Promise<string | null>;
  saveCursor(cursor: string | null, ok: boolean, error?: string | null): Promise<void>;
  findByExternalIds(ids: string[]): Promise<LocalSyncedTask[]>;
  dependencyCandidates(groupIds: string[]): Promise<{ id: string; external_group_id: string | null; due_at: string | null }[]>;
  insertTask(fields: SyncedFields & { depends_on: string[] }): Promise<{ id: string } | { duplicate: true }>;
  updateTask(id: string, fields: Partial<SyncedFields> & { depends_on?: string[]; local_dirty?: boolean; last_synced_at: string }): Promise<void>;
  supersedeOutbox(taskId: string): Promise<void>;
  claimOutbox(limit: number): Promise<OutboxItem[]>;
  completeOutbox(id: string, ok: boolean, error?: string): Promise<string | null>;
  log(entry: LogEntry): Promise<void>;
}

export type SyncReport = {
  pushed: number;
  pushConflicts: number;
  pushFailed: number;
  pulled: number;
  inserted: number;
  updated: number;
  conflicts: number;
  skipped: number;
  pages: number;
  error?: string;
};

/** Push: invia lo stato delle task completate/riaperte in Personal OS. */
export async function pushOutbox(store: SyncStore, client: IronEdgeClient, report: SyncReport) {
  const items = await store.claimOutbox(25);
  for (const item of items) {
    const parsed = statusUpdateSchema.safeParse(item.payload);
    if (!parsed.success) {
      await store.completeOutbox(item.id, false, "payload non valido");
      await store.log({ direction: "push", outcome: "error", entity_id: item.entity_id, detail: "payload outbox non valido" });
      report.pushFailed++;
      continue;
    }
    try {
      const r = await client.setStatus(parsed.data, item.idempotency_key);
      const now = new Date().toISOString();
      if (r.result === "not_found") {
        await store.updateTask(item.entity_id, { local_dirty: false, last_synced_at: now });
        await store.completeOutbox(item.id, true);
        await store.log({ direction: "push", outcome: "error", entity_id: item.entity_id, external_id: parsed.data.external_id, detail: "occorrenza non trovata in IronEdge" });
        report.pushFailed++;
        continue;
      }
      // applica lo stato autorevole restituito da IronEdge (anche in caso di conflitto)
      const status = r.status === "done" ? "done" : r.status === "skipped" ? "skipped" : "todo";
      await store.updateTask(item.entity_id, {
        status,
        completed_at: status === "done" ? (r.completed_at ?? now) : null,
        external_version: r.version ?? undefined,
        local_dirty: false,
        last_synced_at: now,
      });
      await store.completeOutbox(item.id, true);
      if (r.result === "conflict") {
        report.pushConflicts++;
        await store.log({ direction: "push", outcome: "conflict", entity_id: item.entity_id, external_id: parsed.data.external_id, detail: `IronEdge autorevole: stato mantenuto "${r.status}"` });
      } else {
        report.pushed++;
        await store.log({ direction: "push", outcome: r.result === "noop" ? "skipped" : "ok", entity_id: item.entity_id, external_id: parsed.data.external_id });
      }
    } catch (e) {
      const err = e instanceof IronEdgeError ? e.message : `Errore: ${(e as Error).name}`;
      const st = await store.completeOutbox(item.id, false, err);
      report.pushFailed++;
      await store.log({ direction: "push", outcome: "error", entity_id: item.entity_id, external_id: parsed.data.external_id, detail: `${err} (${st === "dead" ? "tentativi esauriti" : "nuovo tentativo programmato"})` });
    }
  }
}

/** Pull incrementale con cursore e paginazione. */
export async function pullChanges(store: SyncStore, client: IronEdgeClient, today: string, report: SyncReport) {
  let cursor = await store.getCursor();
  const from = addDays(today, -7);
  const to = addDays(today, 21);
  for (let page = 0; page < 10; page++) {
    const res = await client.list({ since: cursor, from, to, limit: 200 });
    report.pages++;
    const valid = res.items.filter((i) => remoteTaskSchema.safeParse(i).success);
    const locals = await store.findByExternalIds(valid.map((i) => `occ:${i.occurrence_id}`));
    const byExt = new Map(locals.map((l) => [l.external_id, l]));
    const deps = await store.dependencyCandidates([...new Set(valid.flatMap((i) => i.depends_on))]);
    const now = new Date().toISOString();
    for (const remote of valid) {
      report.pulled++;
      const local = byExt.get(`occ:${remote.occurrence_id}`);
      const d = decidePull(remote, local, store.timeZone);
      const dependsOn = resolveDependencies(remote.depends_on, mapRemote(remote, store.timeZone).due_at, deps);
      if (d.action === "skip") {
        report.skipped++;
        continue;
      }
      if (d.action === "insert") {
        const r = await store.insertTask({ ...d.fields, depends_on: dependsOn });
        if ("duplicate" in r) {
          report.skipped++;
          await store.log({ direction: "pull", outcome: "duplicate", external_id: d.fields.external_id, detail: "gia' presente (sync concorrente)" });
        } else {
          report.inserted++;
        }
        continue;
      }
      if (d.action === "update_metadata") {
        await store.updateTask(d.id, { ...d.fields, depends_on: dependsOn, last_synced_at: now });
        report.updated++;
        continue;
      }
      if (d.supersedeOutbox) await store.supersedeOutbox(d.id);
      await store.updateTask(d.id, { ...d.fields, depends_on: dependsOn, local_dirty: false, last_synced_at: now });
      report.updated++;
      if (d.conflict) {
        report.conflicts++;
        await store.log({ direction: "pull", outcome: "conflict", entity_id: d.id, external_id: d.fields.external_id, detail: "modificata in entrambe le app: applicato lo stato IronEdge" });
      }
    }
    // seconda passata: dipendenze verso task inserite nello stesso lotto
    const withDeps = valid.filter((r) => r.depends_on.length > 0);
    if (withDeps.length) {
      const fresh = await store.dependencyCandidates([...new Set(withDeps.flatMap((i) => i.depends_on))]);
      const ids = await store.findByExternalIds(withDeps.map((r) => `occ:${r.occurrence_id}`));
      const idByExt = new Map(ids.map((l) => [l.external_id, l.id]));
      for (const r of withDeps) {
        const id = idByExt.get(`occ:${r.occurrence_id}`);
        if (!id) continue;
        await store.updateTask(id, { depends_on: resolveDependencies(r.depends_on, mapRemote(r, store.timeZone).due_at, fresh), last_synced_at: now });
      }
    }
    cursor = res.next_cursor ?? cursor;
    if (!res.has_more) break;
  }
  await store.saveCursor(cursor, true);
}

/** Un ciclo completo: prima push (le intenzioni locali), poi pull (stato autorevole). */
export async function runIronEdgeSync(store: SyncStore, client: IronEdgeClient, today: string): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pushConflicts: 0, pushFailed: 0, pulled: 0, inserted: 0, updated: 0, conflicts: 0, skipped: 0, pages: 0 };
  try {
    await pushOutbox(store, client, report);
    await pullChanges(store, client, today, report);
    await store.log({ direction: "pull", outcome: "ok", detail: "ciclo completato", stats: { ...report } });
  } catch (e) {
    report.error = e instanceof IronEdgeError ? e.message : `Errore: ${(e as Error).message?.slice(0, 120)}`;
    await store.saveCursor(await store.getCursor(), false, report.error);
    await store.log({ direction: "pull", outcome: "error", detail: report.error, stats: { ...report } });
  }
  return report;
}
