import type { ComponentProps } from "react";

/**
 * A Markdown table in a box that scrolls sideways. Inline code in a cell never
 * wraps (see `prose.css`), so a table with long values can be wider than the
 * article. The box keeps that width inside the page.
 */
export function ProseTable(props: ComponentProps<"table">) {
  return (
    <div className="prose-table-scroll">
      <table {...props} />
    </div>
  );
}
