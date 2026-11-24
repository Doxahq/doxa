import { useState, type FormEvent } from "react"
import { Bot, Plus, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { addAllowedBotLogin, removeAllowedBotLogin } from "~/lib/dashboard/doxabot-model"
import { useProjectCapabilities } from "~/lib/dashboard/use-project-capabilities"
import { useProjectDoxabot } from "~/lib/dashboard/use-project-doxabot"
import { getErrorMessage } from "~/lib/errors"

/** The bot accounts whose pull requests may start previews. */
export function AllowedBotsCard({ projectId }: { projectId: string }) {
  const state = useProjectDoxabot(projectId)
  // A preview starts a generation, so the list needs `generation.run`.
  const canChange = useProjectCapabilities(projectId).can("generation.run")
  const logins = state.settings?.allowedBotLogins ?? []
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const disabled = !canChange || state.isSaving

  async function save(next: string[], message: string): Promise<boolean> {
    try {
      await state.update({ allowedBotLogins: next })
      toast.success(message)
      return true
    } catch (caught) {
      toast.error(getErrorMessage(caught, "Failed to save the bot list."))
      return false
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const result = addAllowedBotLogin(logins, draft)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    if (await save(result.logins, "Bot added")) setDraft("")
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <Bot aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>
              <h3 id="doxabot-allowed-bots">Allowed bots</h3>
            </CardTitle>
            <CardDescription>
              Doxabot skips pull requests from bots. Add a bot name, for example dependabot, to let its pull
              requests start previews.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 border-t border-border pt-4">
        {logins.length > 0 ? (
          <ul aria-labelledby="doxabot-allowed-bots" className="flex flex-col border border-border">
            {logins.map((login) => (
              <li
                key={login}
                className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 first:border-t-0"
              >
                <span className="truncate font-mono text-[13px] text-foreground">{login}</span>
                {canChange ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    aria-label={`Remove ${login}`}
                    onClick={() => void save(removeAllowedBotLogin(logins, login), "Bot removed")}
                  >
                    <X aria-hidden="true" />
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No bots are allowed.</p>
        )}
        {canChange ? (
          <form onSubmit={(event) => void add(event)} className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  if (error) setError(null)
                }}
                placeholder="dependabot"
                aria-label="Bot name"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "doxabot-allowed-bots-error" : undefined}
                disabled={disabled}
                className="h-9 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="outline" disabled={disabled || draft.trim() === ""}>
                <Plus aria-hidden="true" />
                Add
              </Button>
            </div>
            {error ? (
              <p id="doxabot-allowed-bots-error" className="text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}
