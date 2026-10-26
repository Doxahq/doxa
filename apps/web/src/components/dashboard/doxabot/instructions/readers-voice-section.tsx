import type { ReactNode } from "react"

import {
  SegmentedControl,
  SettingsSection,
} from "~/components/dashboard/content/site-settings/fields/controls"
import {
  ADDRESS_OPTIONS,
  LEVEL_OPTIONS,
  READER_OPTIONS,
  TONE_OPTIONS,
} from "~/lib/dashboard/doxabot-instructions-model"

import type { InstructionsSectionProps } from "./section-props"

export function ReadersVoiceSection({ instructions, update, disabled }: InstructionsSectionProps) {
  return (
    <SettingsSection
      title="Readers and voice"
      description="Doxabot picks depth, examples and wording for this reader."
    >
      <Choice label="Who reads these docs?">
        <SegmentedControl
          label="Who reads these docs?"
          value={instructions.audience.reader}
          options={READER_OPTIONS}
          disabled={disabled}
          onValueChange={(reader) => update((current) => ({ ...current, audience: { ...current.audience, reader } }))}
        />
      </Choice>
      <div className="grid gap-5 sm:grid-cols-3">
        <Choice label="Experience">
          <SegmentedControl
            label="Experience"
            value={instructions.audience.level}
            options={LEVEL_OPTIONS}
            disabled={disabled}
            onValueChange={(level) => update((current) => ({ ...current, audience: { ...current.audience, level } }))}
          />
        </Choice>
        <Choice label="Tone">
          <SegmentedControl
            label="Tone"
            value={instructions.voice.tone}
            options={TONE_OPTIONS}
            disabled={disabled}
            onValueChange={(tone) => update((current) => ({ ...current, voice: { ...current.voice, tone } }))}
          />
        </Choice>
        <Choice label="Address the reader as">
          <SegmentedControl
            label="Address the reader as"
            value={instructions.voice.address}
            options={ADDRESS_OPTIONS}
            disabled={disabled}
            onValueChange={(address) => update((current) => ({ ...current, voice: { ...current.voice, address } }))}
          />
        </Choice>
      </div>
    </SettingsSection>
  )
}

/** A label over one segmented control. The control names itself for screen readers. */
function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span aria-hidden="true" className="text-[13px] font-medium text-foreground">
        {label}
      </span>
      <div className="max-w-full overflow-x-auto">{children}</div>
    </div>
  )
}
