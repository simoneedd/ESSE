"use client";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, className = "btn primary", name, value, ariaLabel }: { children: ReactNode; className?: string; name?: string; value?: string; ariaLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} name={name} value={value} aria-label={ariaLabel} aria-busy={pending}>
      {pending ? "…" : children}
    </button>
  );
}
