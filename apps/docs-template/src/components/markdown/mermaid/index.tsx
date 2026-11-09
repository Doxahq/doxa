import { createIsomorphicFn } from "@tanstack/react-start";
import { lazy, Suspense } from "react";

interface MermaidProps {
  chart: string;
  className?: string;
}

/** The compiler keeps one branch per build, so each bundle has only its own import. */
const loadMermaid = createIsomorphicFn()
  .server(() => import("@/src/components/markdown/mermaid/component.server"))
  .client(() => import("@/src/components/markdown/mermaid/component"));

const MermaidLazy = lazy(loadMermaid);

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
