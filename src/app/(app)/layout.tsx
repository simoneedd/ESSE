import Link from "next/link";
import { SidebarNav, TabBar } from "@/components/NavLinks";
import { ThemeToggle } from "@/components/ThemeToggle";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireUser();
  const { count } = await ctx.db.from("plan_proposals").select("id", { count: "exact", head: true }).eq("status", "pending");
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">E</span>
          <span>Esse<small className="meta">Personal OS</small></span>
        </div>
        <SidebarNav />
        <div className="grow" />
        <div className="row-between" style={{ padding: "8px 10px" }}>
          <span className="meta truncate">{ctx.profile.display_name ?? "Il mio spazio"}</span>
          <div className="row">
            <ThemeToggle />
            <form action="/auth/signout" method="post"><button className="btn ghost small" type="submit">Esci</button></form>
          </div>
        </div>
      </aside>
      <main id="contenuto" className="main">
        {count ? (
          <p className="notice" style={{ marginBottom: 16 }}>
            {count} {count === 1 ? "proposta attende" : "proposte attendono"} la tua approvazione · <Link href="/oggi#proposte">Rivedi</Link>
          </p>
        ) : null}
        {children}
      </main>
      <TabBar />
    </div>
  );
}
