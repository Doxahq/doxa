/** A muted counter beside a section title, such as "3 of 10". */
export function SectionCounter({ children }: { children: string }) {
  return <span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground uppercase">{children}</span>
}
