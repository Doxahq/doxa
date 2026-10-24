import type { Rich } from "~/lib/marketing/pricing"

/** Renders text runs, with placeholders in the `.ph` style. */
export function RichText({ runs }: { runs: Rich[] }) {
  return runs.map((run, i) =>
    typeof run === "string" ? (
      run
    ) : (
      <span key={i} className="ph">
        {run.ph}
      </span>
    ),
  )
}
