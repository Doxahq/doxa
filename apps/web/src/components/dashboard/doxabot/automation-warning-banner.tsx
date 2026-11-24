import { TriangleAlert } from "lucide-react"

import type { DoxabotAutomationNotice } from "~/lib/dashboard/doxabot-model"

/** Says why Doxabot stopped updating the site. A tinted box, no side stripe. */
export function DoxabotAutomationWarningBanner({ notice }: { notice: DoxabotAutomationNotice }) {
  return (
    <section
      role="status"
      aria-labelledby="doxabot-automation-warning"
      className="flex gap-3 border border-warning/35 bg-warning/8 px-4 py-3"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-col gap-1">
        <p id="doxabot-automation-warning" className="text-[13.5px] font-medium text-foreground">
          {notice.title}
        </p>
        <p className="text-[13px] leading-5 break-words text-body">{notice.description}</p>
      </div>
    </section>
  )
}
