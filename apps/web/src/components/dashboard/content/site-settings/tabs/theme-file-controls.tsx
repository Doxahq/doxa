import { useRef, useState } from "react"
import { Download, Upload } from "lucide-react"
import {
  parseThemeFileStrict,
  SITE_CONFIG_LIMITS,
  createValidationIssue,
  type ResolvedTheme,
  type ValidationIssue,
} from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { applyThemeFile, createThemeFile } from "~/lib/dashboard/site-settings-edits"
import { describePointer } from "~/lib/dashboard/site-settings-issues"

/**
 * Upload a `theme.json`, or export the current theme as one.
 *
 * An upload is checked in the browser with the strict theme schema. If the
 * file has errors, nothing changes and the errors are listed. A valid file
 * replaces the color and font choices; the normal save rules then apply.
 */
export function ThemeFileControls({ resolved }: { resolved: ResolvedTheme }) {
  const { state } = useSiteSettingsContext()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [fileIssues, setFileIssues] = useState<readonly ValidationIssue[]>([])
  const [appliedName, setAppliedName] = useState<string | null>(null)

  async function onFile(file: File | undefined) {
    setAppliedName(null)
    if (!file) return
    if (file.size > SITE_CONFIG_LIMITS.themeBytes) {
      setFileIssues([createValidationIssue("invalid_theme_file")])
      return
    }
    let input: unknown
    try {
      input = JSON.parse(await file.text())
    } catch {
      setFileIssues([createValidationIssue("invalid_json")])
      return
    }
    const parsed = parseThemeFileStrict(input)
    if (!parsed.ok) {
      setFileIssues(parsed.issues)
      return
    }
    setFileIssues([])
    setAppliedName(parsed.theme.name)
    state.update((current) => ({ ...current, theme: applyThemeFile(current.theme, parsed.theme) }))
  }

  function exportTheme() {
    const file = createThemeFile(resolved, `${state.config.name || "Docs"} theme`)
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "theme.json"
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void onFile(event.currentTarget.files?.[0])
            event.currentTarget.value = ""
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          <Upload aria-hidden="true" />
          Upload theme.json
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={exportTheme}>
          <Download aria-hidden="true" />
          Export theme.json
        </Button>
      </div>
      {appliedName ? (
        <p role="status" className="text-xs text-success">
          Applied "{appliedName}". Review the preview, then close the dialog to keep it.
        </p>
      ) : null}
      {fileIssues.length > 0 ? (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <p className="text-xs font-medium text-destructive">The theme file was not applied.</p>
          <ul className="space-y-0.5">
            {fileIssues.map((issue, index) => (
              <li key={index} className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{issue.path === "" ? "File" : describePointer(issue.path)}</span>
                {": "}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
