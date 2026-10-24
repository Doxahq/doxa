import {
  DOXABOT_BATCH_QUIET_MINUTES,
  type DoxabotBatchQuietMinutes,
  type DoxabotMergeTrigger,
} from "@doxahq/contracts"

/** The three answers to "when a pull request merges", in display order. */
export const MERGE_TRIGGER_OPTIONS: ReadonlyArray<{
  value: DoxabotMergeTrigger
  title: string
  description: string
}> = [
  {
    value: "manual",
    title: "Mark as unpublished changes",
    description: "Doxa lists the merged pull requests. You start the update with Generate.",
  },
  {
    value: "batched",
    title: "Update after merges stop",
    description:
      "Doxa waits until no pull request has merged for the time you choose, then runs one update for all of them.",
  },
  {
    value: "every_merge",
    title: "Update on every merge",
    description: "Each merge starts a run. This uses the most generation credits.",
  },
]

export const QUIET_TIME_OPTIONS: ReadonlyArray<{ value: DoxabotBatchQuietMinutes; label: string }> =
  DOXABOT_BATCH_QUIET_MINUTES.map((minutes) => ({ value: minutes, label: formatQuietTime(minutes) }))

export function formatQuietTime(minutes: DoxabotBatchQuietMinutes): string {
  return minutes >= 60 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}` : `${minutes} minutes`
}

/** What happens next to the merged pull requests, for the overview. */
export function pendingMergesNextStep(input: {
  mergeTrigger: DoxabotMergeTrigger
  batchQuietMinutes: DoxabotBatchQuietMinutes
}): string {
  switch (input.mergeTrigger) {
    case "manual":
      return "Generate to bring them into your docs."
    case "batched":
      return `Doxa updates your docs ${formatQuietTime(input.batchQuietMinutes)} after the last merge.`
    case "every_merge":
      return "Doxa updates your docs after each merge."
  }
}

export function parseQuietMinutes(value: string): DoxabotBatchQuietMinutes | null {
  return QUIET_TIME_OPTIONS.find((option) => String(option.value) === value)?.value ?? null
}
