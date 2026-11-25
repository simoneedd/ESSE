import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDb } from "./harness";

const sql = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("rollback, smoke test e conteggi", () => {
  it("smoke test passa su un database migrato", async () => {
    const db = await createDb();
    await expect(db.exec(sql("supabase/tests/smoke.sql"))).resolves.toBeDefined();
  }, 60_000);

  it("ciclo up/down/up delle migrazioni", async () => {
    const db = await createDb();
    await db.exec(sql("supabase/rollback/20261126000001-2_down.sql"));
    expect((await db.query<{ n: number }>("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n).toBe(0);
    const dir = join(process.cwd(), "supabase/migrations");
    for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
    expect((await db.query<{ n: number }>("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n).toBe(39);
  }, 60_000);

  it("row-counts.sql restituisce solo conteggi per tutte le tabelle", async () => {
    const db = await createDb();
    const res = await db.exec(sql("supabase/tests/row-counts.sql"));
    const rows = res.at(-1)!.rows as Record<string, string>[];
    expect(rows).toHaveLength(39);
    expect(Object.values(rows[0])[0]).toMatch(/^[a-z_]+\|\d+$/);
  }, 60_000);
});
