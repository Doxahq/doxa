import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges Tailwind class lists, matching the helper both apps already use. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
