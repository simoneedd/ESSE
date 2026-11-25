/**
 * Harness di test database: Postgres reale in-process (PGlite) con stub minimo
 * degli oggetti Supabase (ruoli anon/authenticated/service_role, auth.uid()).
 * Applica le migrazioni versionate esattamente come in produzione.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
`;

export type Db = PGlite & {
  as: <T>(userId: string | null, fn: () => Promise<T>) => Promise<T>;
  asService: <T>(fn: () => Promise<T>) => Promise<T>;
};

export async function createDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(dir, file), "utf8"));
  }
  const db = pg as Db;
  db.as = async (userId, fn) => {
    await pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
    try {
      return await fn();
    } finally {
      await pg.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    }
  };
  db.asService = async (fn) => {
    await pg.exec(`set role service_role;`);
    try {
      return await fn();
    } finally {
      await pg.exec(`reset role;`);
    }
  };
  return db;
}

export const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const USER_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const USER_C = "cccccccc-0000-4000-8000-000000000003";
