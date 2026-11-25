/**
 * Test di contratto CROSS-REPOSITORY: Personal OS (client + DB reali) contro l'handler REALE di
 * IronEdge Growth OS e le sue migrazioni SQL reali (PGlite). Eseguito solo se il repository
 * IronEdge con la patch di integrazione e' disponibile localmente (IRONEDGE_REPO, default
 * ../ironedge-growth-os). In CI di Personal OS viene saltato: il lato IronEdge ha i propri test.
 */
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createIronEdgeClient, runIronEdgeSync } from "@/lib/sync/ironedge";
import { createDb, type Db, USER_A } from "../db/harness";
import { pgliteSyncStore } from "../helpers/pglite-sync-store";

const IE = resolve(process.env.IRONEDGE_REPO ?? join(process.cwd(), "..", "ironedge-growth-os"));
const available = existsSync(join(IE, "src/lib/personal-os.ts")) && existsSync(join(IE, "supabase/migrations/20261126000001_personal_os_integration.sql"));

const SECRET = "c".repeat(48);
const IE_USER = "aaaaaaaa-0000-4000-8000-000000000001";

describe.skipIf(!available)("contratto reale con IronEdge Growth OS", () => {
  let ie: PGlite;
  let po: Db;
  let wsId = "";
  let fetchImpl: typeof fetch;
  const today = new Date().toISOString().slice(0, 10);

  const asIeUser = async <T>(fn: () => Promise<T>) => {
    await ie.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${IE_USER}', false);`);
    try {
      return await fn();
    } finally {
      await ie.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
    }
  };
  const asIeService = async <T>(fn: () => Promise<T>) => {
    await ie.exec("set role service_role;");
    try {
      return await fn();
    } finally {
      await ie.exec("reset role;");
    }
  };

  beforeAll(async () => {
    ie = new PGlite();
    await ie.exec(readFileSync(join(IE, "supabase/tests/supabase-stub.sql"), "utf8"));
    const dir = join(IE, "supabase/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await ie.exec(readFileSync(join(dir, f), "utf8"));
    wsId = await asIeUser(async () => (await ie.query<{ id: string }>("select public.create_workspace('IronEdge') id")).rows[0].id);
    await asIeUser(() => ie.query("select public.generate_task_occurrences($1, $2::date)", [wsId, today]));
    // priorita'/durata sulle task del gestionale (nuove colonne opzionali)
    await asIeUser(() => ie.query("update public.tasks set priority = 1, estimated_minutes = 45 where workspace_id = $1 and sort_order = 2", [wsId]));

    type Handler = (admin: unknown, env: unknown, req: { method: string; url: string; headers: Headers; body: string }) => Promise<{ status: number; body: unknown }>;
    const mod = (await import(/* @vite-ignore */ join(IE, "src/lib/personal-os.ts"))) as { handlePersonalOs: Handler };
    // admin.rpc -> funzioni SQL reali eseguite come service role
    const admin = {
      async rpc(fn: string, args: Record<string, unknown>) {
        const keys = Object.keys(args);
        const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
        try {
          const r = await asIeService(() => ie.query<Record<string, unknown>>(sql, keys.map((k) => args[k])));
          const scalar = r.rows.length === 1 && Object.keys(r.rows[0]).length === 1 && Object.keys(r.rows[0])[0] === fn;
          return { data: scalar ? r.rows[0][fn] : r.rows, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
    };
    const env = {
      AI_PROVIDER: "none",
      AI_MODEL: "x",
      AI_MONTHLY_BUDGET_USD: 0,
      AI_MAX_REQUESTS_PER_DAY: 0,
      PERSONAL_OS_SHARED_SECRET: SECRET,
      PERSONAL_OS_WORKSPACE_ID: wsId,
      PERSONAL_OS_ACTOR_USER_ID: IE_USER,
    };
    fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const r = await mod.handlePersonalOs(admin, env, {
        method: init?.method ?? "GET",
        url: String(input),
        headers: new Headers(init?.headers),
        body: (init?.body as string) ?? "",
      });
      return Response.json(r.body, { status: r.status });
    }) as typeof fetch;

    po = await createDb();
    await po.as(USER_A, () => po.query("select public.ensure_profile()"));
  }, 120_000);

  it("pull delle 6 occorrenze di oggi con priorita' e durata dal gestionale", async () => {
    const r = await runIronEdgeSync(pgliteSyncStore(po, USER_A, "UTC"), createIronEdgeClient("https://ironedge.example.com", SECRET, fetchImpl), today);
    expect(r.error).toBeUndefined();
    expect(r.inserted).toBe(6);
    const t = await po.asService(async () => (await po.query<{ priority: number; estimated_minutes: number }>("select priority, estimated_minutes from public.tasks where priority = 1")).rows);
    expect(t).toEqual([{ priority: 1, estimated_minutes: 45 }]);
  });

  it("completamento da Personal OS -> occorrenza done nel gestionale, con audit IronEdge", async () => {
    const id = await po.asService(async () => (await po.query<{ id: string; external_id: string }>("select id, external_id from public.tasks where priority = 1")).rows[0]);
    await po.as(USER_A, () => po.query("update public.tasks set status = 'done' where id = $1", [id.id]));
    const r = await runIronEdgeSync(pgliteSyncStore(po, USER_A, "UTC"), createIronEdgeClient("https://ironedge.example.com", SECRET, fetchImpl), today);
    expect(r.pushed).toBe(1);
    const occ = await asIeService(async () => (await ie.query<{ status: string; completed_by: string }>("select status, completed_by from public.task_occurrences where id = $1", [id.external_id.slice(4)])).rows[0]);
    expect(occ).toEqual({ status: "done", completed_by: IE_USER });
    const audit = await asIeService(async () => (await ie.query<{ n: number }>("select count(*)::int n from public.audit_events where action = 'personal_os_status'")).rows[0].n);
    expect(audit).toBe(1);
  });

  it("modifica fatta in IronEdge (skip) arriva in Personal OS", async () => {
    const occId = await asIeService(async () => (await ie.query<{ id: string }>("select id from public.task_occurrences where status = 'open' limit 1")).rows[0].id);
    await asIeUser(() => ie.query("select public.set_occurrence_status($1, 'skipped')", [occId]));
    await runIronEdgeSync(pgliteSyncStore(po, USER_A, "UTC"), createIronEdgeClient("https://ironedge.example.com", SECRET, fetchImpl), today);
    const st = await po.asService(async () => (await po.query<{ status: string }>("select status from public.tasks where external_id = $1", [`occ:${occId}`])).rows[0].status);
    expect(st).toBe("skipped");
  });

  it("firma con segreto errato rifiutata dal gestionale", async () => {
    await expect(createIronEdgeClient("https://ironedge.example.com", "z".repeat(48), fetchImpl).list({ since: null, from: today, to: today })).rejects.toThrow(/401/);
  });
});
