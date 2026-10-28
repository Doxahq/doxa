import { lazy, Suspense } from "react";

interface MermaidProps {
  chart: string;
  className?: string;
}

const MermaidLazy = lazy(() =>
  import.meta.env.SSR
    ? import("@/src/components/markdown/mermaid/component.server")
    : import("@/src/components/markdown/mermaid/component")
);

export default function Mermaid(props: MermaidProps) {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-muted-foreground">Loading diagram…</div>
      }
    >
      <MermaidLazy {...props} />
    </Suspense>
  );
}
