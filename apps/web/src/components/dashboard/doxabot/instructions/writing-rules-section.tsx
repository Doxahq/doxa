import { Plus, X } from "lucide-react"
import {
  DOXABOT_INSTRUCTION_LIMITS,
  type DoxabotInstructionScreening,
} from "@doxahq/contracts/doxabot-instructions"
import { isRuleFlagged } from "@doxahq/contracts/doxabot-instruction-screening"

import { SettingsSection, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { Button } from "~/components/ui/button"
import { removeAt, replaceAt } from "~/lib/dashboard/doxabot-instructions-model"
import { cn } from "~/lib/utils"

import { FlaggedTextNotice } from "./flagged-text-notice"
import { SectionCounter } from "./section-counter"
import { countLabel, type InstructionsSectionProps } from "./section-props"

export function WritingRulesSection({
  instructions,
  update,
  disabled,
  screening,
}: InstructionsSectionProps & { screening: DoxabotInstructionScreening }) {
  const rules = instructions.rules
  const isFull = rules.length >= DOXABOT_INSTRUCTION_LIMITS.rules

  return (
    <SettingsSection
      title="Writing rules"
      description="Short rules about style and content. One rule per line."
      actions={<SectionCounter>{countLabel(rules.length, DOXABOT_INSTRUCTION_LIMITS.rules)}</SectionCounter>}
    >
      {rules.length > 0 ? (
        <ol className="flex flex-col gap-2.5">
          {rules.map((rule, index) => {
            const flagged = isRuleFlagged(screening, index)
            return (
              <li key={index} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <TextInput
                    aria-label={`Rule ${index + 1}`}
                    aria-invalid={flagged}
                    value={rule}
                    maxLength={DOXABOT_INSTRUCTION_LIMITS.ruleLength}
                    disabled={disabled}
                    className={cn("min-w-0 flex-1", flagged && "border-warning/60")}
                    onValueChange={(text) => update((current) => ({ ...current, rules: replaceAt(current.rules, index, text) }))}
                  />
                  <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {rule.length}/{DOXABOT_INSTRUCTION_LIMITS.ruleLength}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove rule ${index + 1}`}
                    disabled={disabled}
                    onClick={() => update((current) => ({ ...current, rules: removeAt(current.rules, index) }))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {flagged ? (
                  <div className="ml-7">
                    <FlaggedTextNotice subject="rule" />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled || isFull}
        onClick={() => update((current) => ({ ...current, rules: [...current.rules, ""] }))}
      >
        <Plus aria-hidden="true" />
        Add rule
      </Button>
    </SettingsSection>
  )
}
