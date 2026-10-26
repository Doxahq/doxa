import { Plus, X } from "lucide-react"
import { DOXABOT_INSTRUCTION_LIMITS } from "@doxahq/contracts/doxabot-instructions"

import { SettingsSection, TextInput } from "~/components/dashboard/content/site-settings/fields/controls"
import { KeywordInput } from "~/components/dashboard/content/site-settings/fields/keyword-field"
import { Button } from "~/components/ui/button"
import { removeAt, replaceAt } from "~/lib/dashboard/doxabot-instructions-model"

import { SectionCounter } from "./section-counter"
import { countLabel, fieldId, type InstructionsSectionProps } from "./section-props"

export function TerminologySection({ instructions, update, disabled }: InstructionsSectionProps) {
  const terms = instructions.terminology
  const isFull = terms.length >= DOXABOT_INSTRUCTION_LIMITS.terms

  return (
    <SettingsSection
      title="Terminology"
      description="Doxa checks every generated page for the words you avoid."
      actions={<SectionCounter>{countLabel(terms.length, DOXABOT_INSTRUCTION_LIMITS.terms)}</SectionCounter>}
    >
      {terms.length > 0 ? (
        <div className="surface-card overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead>
              <tr className="border-b border-border font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">
                <th scope="col" className="w-2/5 px-3 py-2 text-left font-medium">Use</th>
                <th scope="col" className="px-3 py-2 text-left font-medium">Instead of</th>
                <th scope="col" className="w-12"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {terms.map((entry, index) => (
                <tr key={index} className="border-t border-border first:border-t-0">
                  <td className="px-3 py-2 align-top">
                    <TextInput
                      aria-label={`Term ${index + 1}`}
                      value={entry.use}
                      maxLength={DOXABOT_INSTRUCTION_LIMITS.termLength}
                      disabled={disabled}
                      onValueChange={(use) => update((current) => ({
                        ...current,
                        terminology: replaceAt(current.terminology, index, { ...current.terminology[index]!, use }),
                      }))}
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <KeywordInput
                      id={fieldId(`term-${index}-avoid`)}
                      aria-invalid={false}
                      aria-describedby={undefined}
                      onBlur={() => undefined}
                      itemNoun="term"
                      disabled={disabled}
                      placeholder="Add a word to avoid"
                      max={DOXABOT_INSTRUCTION_LIMITS.avoidedPerTerm}
                      keywords={entry.avoid}
                      onChange={(avoid) => update((current) => ({
                        ...current,
                        terminology: replaceAt(current.terminology, index, { ...current.terminology[index]!, avoid }),
                      }))}
                    />
                  </td>
                  <td className="px-1 py-2 text-right align-top">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove term ${entry.use || index + 1}`}
                      disabled={disabled}
                      onClick={() => update((current) => ({ ...current, terminology: removeAt(current.terminology, index) }))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || isFull}
          onClick={() => update((current) => ({ ...current, terminology: [...current.terminology, { use: "", avoid: [] }] }))}
        >
          <Plus aria-hidden="true" />
          Add term
        </Button>
        <span className="text-xs text-muted-foreground">Letters, numbers, spaces and - _ . &apos; / only.</span>
      </div>
    </SettingsSection>
  )
}
