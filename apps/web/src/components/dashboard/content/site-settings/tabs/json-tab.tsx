import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, WandSparkles } from "lucide-react"
import { siteConfigJsonSchema } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import { CodeEditor, type CodeEditorHandle } from "~/components/code-editor/code-editor"
import {
  createJsonLanguage,
  locateJsonPointer,
  toJsonSchemaNode,
} from "~/components/code-editor/languages/json"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { parseSettingsJson, formatSettingsJson } from "~/lib/dashboard/site-settings-validation"

/** Parsed once per page load. The schema is generated from the Zod schema. */
const SITE_CONFIG_SCHEMA = toJsonSchemaNode(siteConfigJsonSchema())

export interface JsonRevealRequest {
  pointer: string
  target: "key" | "value"
  /** A new id for each request, so the same pointer can be revealed twice. */
  id: number
}

/**
 * The raw `doxa.json` editor.
 *
 * It edits the same settings as the form. The lint shows the same issues and
 * messages. Text that is not valid stays in the editor and is never saved.
 */
export default function JsonTab({ reveal }: { reveal: JsonRevealRequest | null }) {
  const { state, readOnly } = useSiteSettingsContext()
  const editorRef = useRef<CodeEditorHandle | null>(null)
  const [copied, setCopied] = useState(false)
  const { diagnoseJson, jsonText, setJsonText, saveNow } = state
  const language = useMemo(
    () => createJsonLanguage({ schema: SITE_CONFIG_SCHEMA, diagnose: diagnoseJson }),
    [diagnoseJson],
  )

  useEffect(() => {
    if (!reveal) return
    // The editor mounts in the same commit. Wait one frame for its view.
    const frame = requestAnimationFrame(() => {
      const editorState = editorRef.current?.getState()
      if (!editorState) return
      const range = locateJsonPointer(editorState, reveal.pointer, reveal.target)
      if (range) editorRef.current?.revealRange(range.from, range.to)
    })
    return () => cancelAnimationFrame(frame)
  }, [reveal])

  const parsed = parseSettingsJson(jsonText)

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          The form and this JSON edit the same settings. Press Ctrl+Space for suggestions.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!parsed.ok}
            onClick={() => parsed.ok && setJsonText(formatSettingsJson(parsed.config))}
            title={parsed.ok ? undefined : "Correct the JSON first."}
          >
            <WandSparkles aria-hidden="true" />
            Format
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(jsonText).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      {/* The editor is out of the flow, so a long file scrolls inside the box
          and does not make the box taller. */}
      <div className="relative min-h-[24rem] flex-1 overflow-hidden rounded-lg border border-border">
        <div className="absolute inset-0">
          <CodeEditor
            ref={editorRef}
            value={jsonText}
            onChange={setJsonText}
            onSave={() => void saveNow()}
            readOnly={readOnly}
            language={language}
            ariaLabel="Site settings JSON"
          />
        </div>
      </div>
    </div>
  )
}
