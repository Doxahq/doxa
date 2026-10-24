import type { ReactNode } from "react";

import { cn } from "../lib/cn";

export type NoteVariant = "note" | "success" | "warning" | "danger";

export interface NoteProps {
  title?: string;
  type?: NoteVariant;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<NoteVariant, string> = {
  note: "bg-secondary",
  success:
    "dark:bg-green-950 bg-green-100 border-green-300 dark:border-green-900",
  warning:
    "dark:bg-orange-950 bg-orange-100 border-orange-300 dark:border-orange-900",
  danger: "dark:bg-red-950 bg-red-100 border-red-300 dark:border-red-900",
};

export function Note({ children, title = "Note", type = "note" }: NoteProps) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-0.5 text-sm tracking-wide sm:px-3.5",
        VARIANT_CLASS[type] ?? VARIANT_CLASS.note,
      )}
    >
      <p className="-mb-3 text-sm font-semibold">{title}:</p>
      {children}
    </div>
  );
}
