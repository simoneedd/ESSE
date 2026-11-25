import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { MinuteBars, Progress, Sparkline } from "@/components/ui";

describe("componenti UI", () => {
  it("timeline: orari locali, blocchi fissi marcati, indicatore 'adesso'", () => {
    const html = renderToStaticMarkup(
      <Timeline
        tz="Europe/Rome"
        now={new Date("2026-11-26T09:30:00Z")}
        blocks={[
          { id: "1", starts_at: "2026-11-26T08:00:00Z", ends_at: "2026-11-26T09:00:00Z", title: "Call cliente", area: "marketing", kind: "event", flexibility: "fixed", status: "planned" },
          { id: "2", starts_at: "2026-11-26T10:00:00Z", ends_at: "2026-11-26T11:00:00Z", title: "Studio", area: "study", kind: "study", flexibility: "flexible", status: "planned" },
        ]}
      />,
    );
    expect(html).toContain("09:00");
    expect(html).toContain("fisso");
    expect(html.indexOf("tl-now")).toBeGreaterThan(html.indexOf("Call cliente"));
    expect(html.indexOf("tl-now")).toBeLessThan(html.indexOf("Studio"));
  });
  it("grafici: nessun dato -> messaggio esplicito, mai valori inventati", () => {
    expect(renderToStaticMarkup(<MinuteBars rows={[]} />)).toContain("Nessun tempo registrato");
    expect(renderToStaticMarkup(<Sparkline values={[null, 400]} label="Sonno" />)).toContain("servono almeno 2");
    expect(renderToStaticMarkup(<Progress value={null} label="Corso" />)).toContain("dati insufficienti");
  });
  it("testo utente reso come testo (escaping React, niente HTML iniettato)", () => {
    const html = renderToStaticMarkup(<MinuteBars rows={[{ label: "<img src=x onerror=alert(1)>", minutes: 30 }]} />);
    expect(html).not.toContain("<img");
  });
});
