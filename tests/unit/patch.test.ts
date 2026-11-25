import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Il protocollo nella patch IronEdge deve restare identico a quello di Personal OS (nessuna deriva del contratto). */
describe("patch IronEdge", () => {
  const patch = readFileSync("integrations/ironedge/0001-personal-os-integration.patch", "utf8");
  it("contiene il protocollo identico a src/lib/integration/protocol.ts", () => {
    const start = patch.indexOf("+++ b/src/lib/personal-os-protocol.ts");
    expect(start).toBeGreaterThan(0);
    const hunk = patch.slice(patch.indexOf("@@", start));
    const end = hunk.indexOf("\ndiff --git");
    const lines = (end > 0 ? hunk.slice(0, end) : hunk).split("\n").slice(1).filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    expect(lines.join("\n").trim()).toBe(readFileSync("src/lib/integration/protocol.ts", "utf8").trim());
  });
  it("e' additiva: nessuna istruzione distruttiva nella migrazione", () => {
    const mig = patch.slice(patch.indexOf("+++ b/supabase/migrations/20261126000001_personal_os_integration.sql"));
    const body = mig.slice(0, mig.indexOf("\ndiff --git"));
    expect(body).not.toMatch(/^\+.*\b(drop|truncate|delete from public\.tasks|alter table public\.\w+ drop)\b/im);
  });
});
