import { useRef, useState } from "react"
import { ImageOff, Loader2, Trash2, Upload } from "lucide-react"
import type { AssetRef, SiteAssetKind } from "@doxahq/site-config"

import { Button } from "~/components/ui/button"
import {
  ValidatedField,
  type FieldMessage,
} from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"
import { describeSiteAssetFiles, SITE_ASSET_ACCEPT } from "~/lib/dashboard/site-asset-files"
import { useFileDropZone } from "~/lib/dashboard/use-file-drop-zone"
import { useSiteAssetPreview, useSiteAssetUpload } from "~/lib/dashboard/use-site-asset"
import { cn } from "~/lib/utils"

interface AssetUploadFieldProps {
  pointer: string
  kind: SiteAssetKind
  label: string
  value: AssetRef | null
  onChange: (ref: AssetRef | null) => void
  /** The surface the asset appears on, so a logo is judged on its background. */
  surface?: "light" | "dark"
  hint?: string
  /**
   * Show the file types and the size limit under the field. Turn it off when
   * fields of the same kind share one note.
   */
  showFileRules?: boolean
}

/** Upload, preview, and remove one logo, favicon, or social image. */
export function AssetUploadField({
  pointer,
  kind,
  label,
  value,
  onChange,
  surface = "dark",
  hint,
  showFileRules = true,
}: AssetUploadFieldProps) {
  const { projectId, readOnly } = useSiteSettingsContext()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { upload, isUploading } = useSiteAssetUpload(projectId)
  const preview = useSiteAssetPreview(projectId, value)
  const [uploadIssues, setUploadIssues] = useState<readonly FieldMessage[]>([])
  const fileRules = showFileRules ? describeSiteAssetFiles(kind) : null
  const description = [hint, fileRules].filter(Boolean).join(" ") || undefined
  const drop = useFileDropZone({ disabled: isUploading || readOnly, onFile: (file) => void onFile(file) })

  async function onFile(file: File | undefined) {
    if (!file) return
    setUploadIssues([])
    const result = await upload(kind, file)
    if (result.ok) {
      setUploadIssues(result.warnings)
      onChange(result.ref)
    } else {
      setUploadIssues(result.message ? [{ severity: "error", message: result.message }] : result.issues)
    }
  }

  return (
    <ValidatedField
      pointer={pointer}
      label={label}
      description={description}
      extraIssues={uploadIssues}
    >
      {(control) => (
        <div
          {...drop.zoneProps}
          className={cn(
            "relative flex items-center gap-3 rounded-lg border border-dashed p-3 transition-colors",
            drop.isOver
              ? "border-primary bg-primary-wash"
              : drop.isDragActive
                ? "border-primary/60"
                : "border-border",
          )}
        >
          <div
            className={cn(
              "flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border p-2",
              surface === "light" ? "bg-white" : "bg-black",
            )}
          >
            {value && preview.data ? (
              <img src={preview.data} alt={`${label} preview`} className="max-h-full max-w-full object-contain" />
            ) : value && preview.isPending ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin text-muted-foreground" />
            ) : value ? (
              <ImageOff aria-label="The preview is not available" className="size-4 text-muted-foreground" />
            ) : (
              <span className="font-mono text-[10px] tracking-[0.12em] text-label uppercase">None</span>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <input
                ref={inputRef}
                type="file"
                accept={SITE_ASSET_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  void onFile(event.currentTarget.files?.[0])
                  event.currentTarget.value = ""
                }}
              />
              <Button
                id={control.id}
                type="button"
                variant="outline"
                size="sm"
                disabled={isUploading}
                // The field label names the setting. The button names the action.
                aria-label={`${value ? "Replace" : "Upload"} ${label.toLowerCase()}`}
                aria-invalid={control["aria-invalid"]}
                aria-describedby={control["aria-describedby"]}
                onBlur={control.onBlur}
                onClick={() => inputRef.current?.click()}
              >
                {isUploading ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Upload aria-hidden="true" />}
                {isUploading ? "Uploading…" : value ? "Replace" : "Upload"}
              </Button>
              {value ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${label.toLowerCase()}`}
                  onClick={() => {
                    setUploadIssues([])
                    onChange(null)
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              ) : null}
            </div>
            <p
              className={cn(
                "text-xs transition-colors",
                drop.isDragActive ? "text-primary-text" : "text-muted-foreground",
              )}
            >
              {drop.isDragActive ? "Drop the image here." : "Or drag an image here."}
            </p>
          </div>
          {drop.isOver ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-background/80 font-mono text-[11px] tracking-[0.12em] text-primary-text uppercase"
            >
              <Upload className="size-3.5" />
              Drop to upload
            </div>
          ) : null}
        </div>
      )}
    </ValidatedField>
  )
}
