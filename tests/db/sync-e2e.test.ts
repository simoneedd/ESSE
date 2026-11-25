import { beforeEach, describe, expect, it } from "vitest";
import { HEADER, PROTOCOL_VERSION, verifySignedRequest, type RemoteTask } from "@/lib/integration/protocol";
import { createIronEdgeClient, runIronEdgeSync } from "@/lib/sync/ironedge";
import { pgliteSyncStore } from "../helpers/pglite-sync-store";
import { createDb, type Db, USER_A } from "./harness";

const SECRET = "k".repeat(48);
const TODAY = "2026-11-26";

/** IronEdge simulato: verifica firme reali, nonce monouso, autorevolezza e conflitti. */
function fakeIronEdge() {
  const occ = new Map<string, RemoteTask>();
  const nonces = new Set<string>();
  const received: unknown[] = [];
  let failNext = 0;
  let clock = Date.parse("2026-11-26T07:00:00Z");
  const bump = () => new Date((clock += 1000)).toISOString();
  const add = (id: string, over: Partial<RemoteTask> = {}) => {
    const t: RemoteTask = {
      occurrence_id: id,
      task_id: "aaaaaaaa-0000-4000-8000-00000000000" + (occ.size % 10),
      title: `Task ${occ.size + 1}`,
      description: null,
      priority: 2,
      due_date: null,
      occurrence_date: TODAY,
      estimated_minutes: 30,
      status: "open",
      category: "live",
      depends_on: [],
      completed_at: null,
      version: bump(),
      task_active: true,
      url: "https://ironedge.example.com/impostazioni#task-x",
      ...over,
    };
    occ.set(id, t);
    return t;
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body as string) ?? "";
    const headers = new Headers(init?.headers);
    if (failNext > 0) {
      failNext--;
      return new Response(JSON.stringify({ error: "down" }), { status: 503 });
    }
    const v = verifySignedRequest(SECRET, { method: init?.method ?? "GET", path: url.pathname + url.search, headers, body });
    if (!v.ok || nonces.has(v.nonce)) return new Response("{}", { status: 401 });
    nonces.add(v.nonce);
    if ((init?.method ?? "GET") === "GET") {
      const since = url.searchParams.get("since");
      const items = [...occ.values()].filter((t) => !since || t.version > since).sort((a, b) => a.version.localeCompare(b.version));
      return Response.json({ protocol: PROTOCOL_VERSION, items, next_cursor: items.at(-1)?.version ?? since, has_more: false, server_time: new Date().toISOString() });
    }
    const p = JSON.parse(body);
    received.push({ body: p, idem: headers.get(HEADER.idempotency) });
    const t = occ.get(p.external_id.slice(4));
    if (!t) return Response.json({ protocol: PROTOCOL_VERSION, result: "not_found", status: null, version: null, completed_at: null }, { status: 404 });
    if (t.status === p.status) return Response.json({ protocol: PROTOCOL_VERSION, result: "noop", status: t.status, version: t.version, completed_at: t.completed_at });
    if (p.base_version && t.version > p.base_version) {
      return Response.json({ protocol: PROTOCOL_VERSION, result: "conflict", status: t.status, version: t.version, completed_at: t.completed_at }, { status: 409 });
    }
    t.status = p.status;
    t.completed_at = p.status === "done" ? new Date().toISOString() : null;
    t.version = bump();
    return Response.json({ protocol: PROTOCOL_VERSION, result: "applied", status: t.status, version: t.version, completed_at: t.completed_at });
  }) as typeof fetch;
  return { occ, add, fetchImpl, received, bump, failNextRequests: (n: number) => (failNext = n) };
}

let db: Db;
let ie: ReturnType<typeof fakeIronEdge>;
const client = () => createIronEdgeClient("https://ironedge.example.com", SECRET, ie.fetchImpl);
const store = () => pgliteSyncStore(db, USER_A);
const localTasks = () =>
  db.asService(async () => (await db.query<{ id: string; external_id: string; status: string; title: string; local_dirty: boolean; depends_on: string[] }>("select id, external_id, status, title, local_dirty, depends_on from public.tasks where user_id = $1 order by external_id", [USER_A])).rows);

beforeEach(async () => {
  db = await createDb();
  await db.as(USER_A, () => db.query("select public.ensure_profile()"));
  ie = fakeIronEdge();
}, 60_000);

describe("sincronizzazione IronEdge end-to-end", () => {
  it("pull: importa le task con tutti i campi e senza duplicati su sync ripetute", async () => {
    ie.add("11111111-1111-4111-8111-111111111111", { title: "Preparare la live", priority: 1, estimated_minutes: 45 });
    ie.add("22222222-2222-4222-8222-222222222222");
    const r1 = await runIronEdgeSync(store(), client(), TODAY);
    expect(r1.inserted).toBe(2);
    expect(r1.error).toBeUndefined();
    const r2 = await runIronEdgeSync(store(), client(), TODAY);
    expect(r2.inserted).toBe(0);
    const rows = await localTasks();
    expect(rows).toHaveLength(2);
    const full = await db.asService(async () => (await db.query<Record<string, unknown>>("select * from public.tasks where external_id = 'occ:11111111-1111-4111-8111-111111111111'")).rows[0]);
    expect(full).toMatchObject({ title: "Preparare la live", priority: 1, estimated_minutes: 45, area: "ironedge", category: "live", status: "todo", source: "ironedge" });
    expect(full.external_url).toBe("https://ironedge.example.com/impostazioni#task-x");
  });

  it("completamento da Personal OS aggiornato in IronEdge, con payload minimo", async () => {
    ie.add("11111111-1111-4111-8111-111111111111");
    await runIronEdgeSync(store(), client(), TODAY);
    const [t] = await localTasks();
    await db.as(USER_A, () => db.query("update public.tasks set status = 'done' where id = $1", [t.id]));
    const r = await runIronEdgeSync(store(), client(), TODAY);
    expect(r.pushed).toBe(1);
    expect(ie.occ.get("11111111-1111-4111-8111-111111111111")!.status).toBe("done");
    const sent = ie.received[0] as { body: Record<string, unknown>; idem: string };
    expect(Object.keys(sent.body).sort()).toEqual(["base_version", "external_id", "status"]);
    expect(sent.idem).toMatch(/^task:/);
    const [after] = await localTasks();
    expect(after).toMatchObject({ status: "done", local_dirty: false });
  });

  it("errori temporanei: retry con backoff, nessuna perdita della modifica", async () => {
    ie.add("11111111-1111-4111-8111-111111111111");
    await runIronEdgeSync(store(), client(), TODAY);
    const [t] = await localTasks();
    await db.as(USER_A, () => db.query("update public.tasks set status = 'done' where id = $1", [t.id]));
    ie.failNextRequests(1);
    const r = await runIronEdgeSync(store(), client(), TODAY);
    expect(r.pushFailed).toBe(1);
    expect(ie.occ.get("11111111-1111-4111-8111-111111111111")!.status).toBe("open");
    // simula il passare del tempo: la voce torna disponibile
    await db.asService(() => db.query("update public.sync_outbox set next_attempt_at = now() - interval '1 minute' where status = 'failed'"));
    const r2 = await runIronEdgeSync(store(), client(), TODAY);
    expect(r2.pushed).toBe(1);
    expect(ie.occ.get("11111111-1111-4111-8111-111111111111")!.status).toBe("done");
  });

  it("conflitto: modificata in IronEdge dopo l'ultima sync -> vince IronEdge e viene registrato", async () => {
    ie.add("11111111-1111-4111-8111-111111111111");
    await runIronEdgeSync(store(), client(), TODAY);
    const [t] = await localTasks();
    // in IronEdge qualcuno salta l'occorrenza
    const remote = ie.occ.get("11111111-1111-4111-8111-111111111111")!;
    remote.status = "skipped";
    remote.version = ie.bump();
    await db.as(USER_A, () => db.query("update public.tasks set status = 'done' where id = $1", [t.id]));
    const r = await runIronEdgeSync(store(), client(), TODAY);
    expect(r.pushConflicts).toBe(1);
    expect(remote.status).toBe("skipped");
    const [after] = await localTasks();
    expect(after.status).toBe("skipped");
    const log = await db.asService(async () => (await db.query<{ n: number }>("select count(*)::int n from public.sync_log where outcome = 'conflict'")).rows[0].n);
    expect(log).toBe(1);
  });

  it("aggiornamenti remoti (titolo/stato) applicati; dipendenze risolte in id locali", async () => {
    const a = ie.add("11111111-1111-4111-8111-111111111111", { task_id: "aaaaaaaa-0000-4000-8000-000000000001" });
    ie.add("22222222-2222-4222-8222-222222222222", { task_id: "aaaaaaaa-0000-4000-8000-000000000002", depends_on: ["aaaaaaaa-0000-4000-8000-000000000001"] });
    await runIronEdgeSync(store(), client(), TODAY);
    a.title = "Titolo aggiornato in IronEdge";
    a.status = "done";
    a.completed_at = new Date().toISOString();
    a.version = ie.bump();
    await runIronEdgeSync(store(), client(), TODAY);
    const rows = await localTasks();
    const first = rows.find((r) => r.external_id.endsWith("1111"))!;
    const second = rows.find((r) => r.external_id.endsWith("2222"))!;
    expect(first).toMatchObject({ title: "Titolo aggiornato in IronEdge", status: "done" });
    expect(second.depends_on).toEqual([first.id]);
  });

  it("errore di rete registrato nello stato integrazione senza bloccare l'app", async () => {
    ie.failNextRequests(5);
    const r = await runIronEdgeSync(store(), client(), TODAY);
    expect(r.error).toMatch(/503/);
    const st = await db.asService(async () => (await db.query<{ consecutive_failures: number; last_error: string }>("select consecutive_failures, last_error from public.integration_state")).rows[0]);
    expect(st.consecutive_failures).toBe(1);
  });

  it("il client rifiuta URL non https e non invia campi extra", async () => {
    expect(() => createIronEdgeClient("http://ironedge.example.com", SECRET)).toThrow(/https/);
    await expect(
      client().setStatus({ external_id: "occ:11111111-1111-4111-8111-111111111111", status: "done", base_version: null, sleep: 6 } as never, "task:x:12345678"),
    ).rejects.toThrow();
  });
});
