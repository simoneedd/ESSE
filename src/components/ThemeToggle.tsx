"use client";
import { Moon, Sun } from "lucide-react";

/** Tema chiaro/scuro: segue il sistema; la scelta manuale resta solo nel browser (localStorage). */
export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const current = root.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("pos-theme", next);
    } catch {
      /* storage non disponibile */
    }
  };
  return (
    <button type="button" className="btn ghost small" onClick={toggle} aria-label="Cambia tema chiaro/scuro">
      <Sun className="theme-sun" aria-hidden="true" />
      <Moon className="theme-moon" aria-hidden="true" />
    </button>
  );
}
