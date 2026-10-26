import {
  DOXABOT_INSTRUCTION_LIMITS,
  DOXABOT_PAGE_TYPES,
} from "@doxahq/contracts/doxabot-instructions"
import { DOXABOT_PAGE_TYPE_LABELS } from "@doxahq/contracts/doxabot-instruction-prompt"

import { SettingsSection } from "~/components/dashboard/content/site-settings/fields/controls"
import { KeywordInput } from "~/components/dashboard/content/site-settings/fields/keyword-field"
import { Checkbox } from "~/components/ui/checkbox"
import { togglePageType } from "~/lib/dashboard/doxabot-instructions-model"

import { fieldId, type InstructionsSectionProps } from "./section-props"

export function PagesSection({ instructions, update, disabled }: InstructionsSectionProps) {
  const excludedId = fieldId("do-not-document")

  return (
    <SettingsSection
      title="Pages"
      description="Choose the kinds of pages Doxabot writes, and the code it leaves out of the docs."
    >
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-[13px] font-medium text-foreground">Page types</legend>
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-3">
          {DOXABOT_PAGE_TYPES.map((pageType) => {
            const isOn = instructions.pageTypes.includes(pageType)
            // At least one page type stays on: the API rejects an empty list.
            const isLast = isOn && instructions.pageTypes.length === 1
            return (
              <label key={pageType} className="flex items-center gap-2.5 text-sm text-foreground">
                <Checkbox
                  checked={isOn}
                  disabled={disabled || isLast}
                  onChange={() => update((current) => ({
                    ...current,
                    pageTypes: togglePageType(current.pageTypes, pageType),
                  }))}
                />
                {DOXABOT_PAGE_TYPE_LABELS[pageType]}
              </label>
            )
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor={excludedId} className="text-[13px] font-medium text-foreground">
          Do not document
        </label>
        <KeywordInput
          id={excludedId}
          aria-invalid={false}
          aria-describedby={`${excludedId}-hint`}
          onBlur={() => undefined}
          itemNoun="path"
          disabled={disabled}
          placeholder="Add a path, for example internal/**"
          max={DOXABOT_INSTRUCTION_LIMITS.doNotDocument}
          keywords={instructions.doNotDocument}
          onChange={(doNotDocument) => update((current) => ({ ...current, doNotDocument }))}
        />
        <p id={`${excludedId}-hint`} className="text-xs text-muted-foreground">
          Doxabot still reads these paths to understand the code. It does not write pages about them.
        </p>
      </div>
    </SettingsSection>
  )
}
