import {
  BriefcaseBusiness, CalendarClock, CalendarDays, ChartCandlestick, ChartNoAxesColumn, Dumbbell, GraduationCap,
  LayoutGrid, ListChecks, MoonStar, Repeat, Salad, Settings, ShieldCheck, Sparkles, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  BriefcaseBusiness, CalendarClock, CalendarDays, ChartCandlestick, ChartNoAxesColumn, Dumbbell, GraduationCap,
  LayoutGrid, ListChecks, MoonStar, Repeat, Salad, Settings, ShieldCheck, Sparkles,
};

export function Icon({ name }: { name: string }) {
  const C = ICONS[name] ?? LayoutGrid;
  return <C aria-hidden="true" />;
}
