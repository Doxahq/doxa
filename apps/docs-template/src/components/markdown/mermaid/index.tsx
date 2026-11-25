import { lazy, Suspense } from "react";

interface MermaidProps {
  chart: string;
  className?: string;
}

/**
 * On the server the chunk is already in the Worker bundle, so the diagram is in
 * the first HTML. In the browser, hydration keeps the server SVG until the
 * chunk arrives, so the fallback shows only on a client navigation.
 */
const MermaidLazy = lazy(() => import("@/src/components/markdown/mermaid/component"));

export default function Mermaid(props: MermaidProps) {
  return (
    <Suspense fallback={null}>
      <MermaidLazy {...props} />
    </Suspense>
  );
}
