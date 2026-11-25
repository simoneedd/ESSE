export type NavItem = { href: string; label: string; icon: string; group: string; mobile?: boolean };

export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "LayoutGrid", group: "Oggi", mobile: true },
  { href: "/oggi", label: "Agenda di oggi", icon: "CalendarClock", group: "Oggi", mobile: true },
  { href: "/assistente", label: "Assistente", icon: "Sparkles", group: "Oggi", mobile: true },
  { href: "/calendario", label: "Calendario", icon: "CalendarDays", group: "Oggi" },
  { href: "/task", label: "Task", icon: "ListChecks", group: "Oggi", mobile: true },
  { href: "/marketing", label: "Marketing", icon: "BriefcaseBusiness", group: "Lavoro" },
  { href: "/trading", label: "Trading", icon: "ChartCandlestick", group: "Lavoro" },
  { href: "/studio", label: "Studio", icon: "GraduationCap", group: "Crescita" },
  { href: "/palestra", label: "Palestra", icon: "Dumbbell", group: "Benessere" },
  { href: "/alimentazione", label: "Alimentazione", icon: "Salad", group: "Benessere" },
  { href: "/sonno", label: "Sonno", icon: "MoonStar", group: "Benessere" },
  { href: "/abitudini", label: "Abitudini", icon: "Repeat", group: "Benessere" },
  { href: "/report", label: "Report", icon: "ChartNoAxesColumn", group: "Analisi" },
  { href: "/impostazioni", label: "Impostazioni", icon: "Settings", group: "Sistema", mobile: true },
  { href: "/sicurezza", label: "Sicurezza", icon: "ShieldCheck", group: "Sistema" },
];
