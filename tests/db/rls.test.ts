import { beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, USER_A, USER_B } from "./harness";

let db: Db;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0];
}

async function expectError(fn: () => Promise<unknown>, re: RegExp) {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(String((err as Error | undefined)?.message ?? "nessun errore")).toMatch(re);
}

let taskIe: string;
let clientA: string;

beforeAll(async () => {
  db = await createDb();
  await db.as(USER_A, () => db.query("select public.ensure_profile()"));
  await db.as(USER_B, () => db.query("select public.ensure_profile()"));
  clientA = await db.as(USER_A, async () => (await one<{ id: string }>("insert into public.clients (name) values ('Cliente Alfa') returning id")).id);
  // task IronEdge creata dalla sincronizzazione (service role)
  taskIe = await db.asService(async () =>
    (
      await one<{ id: string }>(
        `insert into public.tasks (user_id, area, title, source, external_id, external_version, priority, estimated_minutes)
         values ($1, 'ironedge', 'Preparare la live', 'ironedge', 'occ:11111111-1111-4111-8111-111111111111', 'v1', 2, 60) returning id`,
        [USER_A],
      )
    ).id,
  );
}, 60_000);

describe("RLS e privilegi", () => {
  it("RLS forzata su tutte le tabelle public", async () => {
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(r.rows).toEqual([]);
  });

  it("anon non ha privilegi su nessuna tabella", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("un utente non vede ne' modifica i dati di un altro", async () => {
    await db.as(USER_B, async () => {
      expect((await one<{ n: number }>("select count(*)::int n from public.clients")).n).toBe(0);
      expect((await one<{ n: number }>("select count(*)::int n from public.tasks")).n).toBe(0);
      const upd = await db.query("update public.clients set name = 'hack' where id = $1", [clientA]);
      expect(upd.affectedRows ?? 0).toBe(0);
    });
  });

  it("impedisce riferimenti a righe di altri utenti", async () => {
    await db.as(USER_B, async () => {
      await expectError(
        () => db.query("insert into public.tasks (title, client_id) values ('x', $1)", [clientA]),
        /Riferimento non valido/,
      );
    });
  });

  it("l'utente non puo' inserire righe a nome di altri", async () => {
    await db.as(USER_B, async () => {
      await expectError(() => db.query("insert into public.clients (user_id, name) values ($1, 'x')", [USER_A]), /row-level security/);
    });
  });

  it("tabelle di sistema non scrivibili dall'utente; token OAuth inaccessibili", async () => {
    await db.as(USER_A, async () => {
      await expectError(
        () => db.query("insert into public.sync_log (user_id, provider, direction, outcome) values ($1, 'x', 'pull', 'ok')", [USER_A]),
        /permission denied/,
      );
      await expectError(() => db.query("select * from public.oauth_tokens"), /permission denied/);
      await expectError(() => db.query("select public.acquire_job(null, 'x', 'y', 60)"), /Solo service role|permission denied/);
    });
  });
});

describe("task IronEdge (fonte autorevole)", () => {
  it("l'utente non puo' creare task esterne", async () => {
    await db.as(USER_A, async () => {
      await expectError(
        () => db.query("insert into public.tasks (title, source, external_id) values ('finta', 'ironedge', 'occ:x')"),
        /Solo la sincronizzazione/,
      );
    });
  });

  it("i campi sincronizzati non sono modificabili da Personal OS", async () => {
    await db.as(USER_A, async () => {
      await expectError(() => db.query("update public.tasks set title = 'altro' where id = $1", [taskIe]), /gestito da IronEdge/);
      await expectError(() => db.query("delete from public.tasks where id = $1", [taskIe]), /non si eliminano/);
    });
  });

  it("completare la task crea UNA voce di outbox con payload minimo, senza dati personali", async () => {
    await db.as(USER_A, async () => {
      await db.query("update public.tasks set status = 'done' where id = $1", [taskIe]);
      const t = await one<{ completed_at: string | null; local_dirty: boolean }>("select completed_at, local_dirty from public.tasks where id = $1", [taskIe]);
      expect(t.completed_at).not.toBeNull();
      expect(t.local_dirty).toBe(true);
    });
    const ob = await db.asService(() =>
      db.query<{ payload: Record<string, unknown>; status: string }>("select payload, status from public.sync_outbox where entity_id = $1 and status = 'pending'", [taskIe]),
    );
    expect(ob.rows.length).toBe(1);
    expect(Object.keys(ob.rows[0].payload).sort()).toEqual(["base_version", "external_id", "status"]);
    expect(ob.rows[0].payload.status).toBe("done");
  });

  it("modifiche successive superano le voci in attesa (solo l'ultimo stato viene inviato)", async () => {
    await db.as(USER_A, () => db.query("update public.tasks set status = 'todo' where id = $1", [taskIe]));
    await db.as(USER_A, () => db.query("update public.tasks set status = 'done' where id = $1", [taskIe]));
    const ob = await db.asService(() =>
      db.query<{ status: string }>("select status from public.sync_outbox where entity_id = $1 and status = 'pending'", [taskIe]),
    );
    expect(ob.rows.length).toBe(1);
  });

  it("stati non supportati da IronEdge rifiutati", async () => {
    await db.as(USER_A, async () => {
      await expectError(() => db.query("update public.tasks set status = 'cancelled' where id = $1", [taskIe]), /consentiti solo/);
    });
  });

  it("claim_outbox / complete_outbox: backoff e dead letter", async () => {
    await db.asService(async () => {
      const claimed = await db.query<{ id: string; attempts: number }>("select id, attempts from public.claim_outbox('ironedge', $1, 10)", [USER_A]);
      expect(claimed.rows.length).toBe(1);
      const id = claimed.rows[0].id;
      // seconda presa: nulla (gia' in processing)
      expect((await db.query("select * from public.claim_outbox('ironedge', $1, 10)", [USER_A])).rows.length).toBe(0);
      const s = await one<{ s: string }>("select public.complete_outbox($1, false, 'HTTP 503') s", [id]);
      expect(s.s).toBe("failed");
      const next = await one<{ due: boolean }>("select next_attempt_at > now() due from public.sync_outbox where id = $1", [id]);
      expect(next.due).toBe(true);
      await db.query("update public.sync_outbox set attempts = 8 where id = $1", [id]);
      expect((await one<{ s: string }>("select public.complete_outbox($1, false, 'x') s", [id])).s).toBe("dead");
    });
  });

  it("deduplica: stessa task esterna non puo' essere inserita due volte", async () => {
    await expectError(
      () =>
        db.asService(() =>
          db.query(
            "insert into public.tasks (user_id, title, source, external_id) values ($1, 'dup', 'ironedge', 'occ:11111111-1111-4111-8111-111111111111')",
            [USER_A],
          ),
        ),
      /duplicate key/,
    );
  });
});

describe("eventi e proposte", () => {
  it("gli eventi Google si importano solo dalla sincronizzazione", async () => {
    await db.as(USER_A, async () => {
      await expectError(
        () =>
          db.query(
            "insert into public.events (title, starts_at, ends_at, origin, gcal_event_id) values ('x', now(), now() + interval '1 hour', 'google', 'abc')",
          ),
        /solo dalla sincronizzazione/,
      );
    });
  });

  it("decide_proposal: solo il proprietario, una sola volta, con audit", async () => {
    const id = await db.as(USER_A, async () =>
      (await one<{ id: string }>("insert into public.plan_proposals (kind, summary) values ('move_event', 'Sposta riunione') returning id")).id,
    );
    await db.as(USER_B, async () => {
      await expectError(() => db.query("select public.decide_proposal($1, true)", [id]), /non trovata/);
    });
    await db.as(USER_A, async () => {
      expect((await one<{ s: string }>("select public.decide_proposal($1, true) s", [id])).s).toBe("approved");
      await expectError(() => db.query("select public.decide_proposal($1, false)", [id]), /gia' decisa/);
      expect((await one<{ n: number }>("select count(*)::int n from public.audit_events where entity_id = $1", [id])).n).toBe(1);
    });
  });

  it("delete_my_data elimina solo i dati dell'utente e richiede conferma", async () => {
    await db.as(USER_B, async () => {
      await db.query("insert into public.sleep_logs (night_of, slept_minutes) values ('2026-11-20', 420)");
      await expectError(() => db.query("select public.delete_my_data('si')"), /Conferma non valida/);
      await db.query("select public.delete_my_data('ELIMINA TUTTO')");
      expect((await one<{ n: number }>("select count(*)::int n from public.sleep_logs")).n).toBe(0);
    });
    await db.as(USER_A, async () => {
      expect((await one<{ n: number }>("select count(*)::int n from public.clients")).n).toBe(1);
    });
  });
});
