import {
  DOXABOT_CODE_LANGUAGES,
  DOXABOT_INSTRUCTION_LIMITS,
} from "@doxahq/contracts/doxabot-instructions"
import { DOXABOT_CODE_LANGUAGE_LABELS } from "@doxahq/contracts/doxabot-instruction-prompt"

import { SettingsSection } from "~/components/dashboard/content/site-settings/fields/controls"
import { toggleCodeLanguage } from "~/lib/dashboard/doxabot-instructions-model"
import { cn } from "~/lib/utils"

import { SectionCounter } from "./section-counter"
import { countLabel, type InstructionsSectionProps } from "./section-props"

export function CodeLanguagesSection({ instructions, update, disabled }: InstructionsSectionProps) {
  const selected = instructions.codeLanguages
  const isFull = selected.length >= DOXABOT_INSTRUCTION_LIMITS.codeLanguages

  return (
    <SettingsSection
      title="Code examples"
      description="Pick up to 6 languages. The first one you pick shows first in each code group."
      actions={<SectionCounter>{countLabel(selected.length, DOXABOT_INSTRUCTION_LIMITS.codeLanguages)}</SectionCounter>}
    >
      <div role="group" aria-label="Code example languages" className="flex flex-wrap gap-2">
        {DOXABOT_CODE_LANGUAGES.map((language) => {
          const isOn = selected.includes(language)
          return (
            <button
              key={language}
              type="button"
              aria-pressed={isOn}
              disabled={disabled || (!isOn && isFull)}
              onClick={() => update((current) => ({
                ...current,
                codeLanguages: toggleCodeLanguage(current.codeLanguages, language),
              }))}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 border px-3 font-mono text-xs transition-colors duration-75 disabled:cursor-not-allowed disabled:opacity-50",
                isOn
                  ? "border-primary bg-primary-wash text-foreground"
                  : "border-border text-muted-foreground enabled:hover:text-foreground",
              )}
            >
              {selected[0] === language ? (
                <span className="text-[9.5px] tracking-widest text-primary-text uppercase">1st</span>
              ) : null}
              {DOXABOT_CODE_LANGUAGE_LABELS[language]}
            </button>
          )
        })}
      </div>
    </SettingsSection>
  )
}
