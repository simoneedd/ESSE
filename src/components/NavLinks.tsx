"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import { Icon } from "./Icon";

export function SidebarNav() {
  const path = usePathname();
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav className="nav" aria-label="Navigazione principale">
      {groups.map((g) => (
        <div key={g}>
          <div className="nav-group">{g}</div>
          {NAV.filter((n) => n.group === g).map((n) => (
            <Link key={n.href} href={n.href} aria-current={(n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "page" : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function TabBar() {
  const path = usePathname();
  return (
    <nav className="tabbar" aria-label="Navigazione rapida">
      {NAV.filter((n) => n.mobile).map((n) => (
        <Link key={n.href} href={n.href} aria-current={(n.href === "/" ? path === "/" : path.startsWith(n.href)) ? "page" : undefined}>
          <Icon name={n.icon} />
          {n.label.split(" ")[0]}
        </Link>
      ))}
    </nav>
  );
}
