import type { OAuthScope } from "@doxahq/contracts/agent-access"

import { FIELD_LABEL_CLASS } from "~/components/dashboard/dashboard-header"
import { Checkbox } from "~/components/ui/checkbox"
import type { ScopeOption } from "~/lib/oauth/consent-model"

/** The permissions as plain sentences with checkboxes. */
export function ConsentScopeList({
  options,
  disabled,
  onToggle,
}: {
  options: readonly ScopeOption[]
  disabled: boolean
  onToggle: (scope: OAuthScope, checked: boolean) => void
}) {
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className={`${FIELD_LABEL_CLASS} mb-2.5`}>The agent can</legend>
      <ul className="border border-border">
        {options.map((option) => (
          <li key={option.scope} className="border-t border-divider first:border-t-0">
            <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3 has-disabled:cursor-default">
              <Checkbox
                className="mt-0.5"
                checked={option.checked}
                disabled={disabled || option.required}
                onChange={(event) => onToggle(option.scope, event.target.checked)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">{option.sentence}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {option.scope}
                  {option.required ? " · needed by another permission" : null}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  )
}
