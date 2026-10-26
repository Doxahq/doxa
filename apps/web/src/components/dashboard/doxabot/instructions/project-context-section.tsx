import {
  DOXABOT_INSTRUCTION_LIMITS,
  type DoxabotInstructionScreening,
} from "@doxahq/contracts/doxabot-instructions"
import { isContextFlagged } from "@doxahq/contracts/doxabot-instruction-screening"

import { SettingsSection, TextArea } from "~/components/dashboard/content/site-settings/fields/controls"

import { FlaggedTextNotice } from "./flagged-text-notice"
import { fieldId, type InstructionsSectionProps } from "./section-props"

export function ProjectContextSection({
  instructions,
  update,
  disabled,
  screening,
}: InstructionsSectionProps & { screening: DoxabotInstructionScreening }) {
  const id = fieldId("context")
  const flagged = isContextFlagged(screening)

  return (
    <SettingsSection
      title="Project context"
      description="What Doxabot cannot learn from your code: who your customers are, what they care about, the words they use."
    >
      <label htmlFor={id} className="sr-only">
        Project context
      </label>
      <TextArea
        id={id}
        rows={6}
        value={instructions.context}
        maxLength={DOXABOT_INSTRUCTION_LIMITS.contextLength}
        disabled={disabled}
        aria-invalid={flagged}
        onValueChange={(context) => update((current) => ({ ...current, context }))}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">{flagged ? <FlaggedTextNotice subject="context" /> : null}</div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {instructions.context.length.toLocaleString("en-US")} / {DOXABOT_INSTRUCTION_LIMITS.contextLength.toLocaleString("en-US")}
        </span>
      </div>
    </SettingsSection>
  )
}
