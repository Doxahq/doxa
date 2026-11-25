import { lazy, Suspense, type ComponentProps, type ReactNode } from "react"
import {
  createMermaid,
  createPre,
  ProseTable,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type FileTreeIcons,
  type MermaidProps,
  type ProseComponentMap,
  type ProseElementMap,
} from "@doxahq/docs-prose"
import { Check, Copy, FileText, Folder, FolderClosed } from "lucide-react"

import { useImageSource } from "~/lib/dashboard/editor-assets"

/**
 * The parts of the docs component set that the dashboard wires itself.
 *
 * Notes, cards, steps, tabs, the file tree, the code fence and the diagram come
 * from `@doxahq/docs-prose`, the same code the published renderer uses. The
 * dashboard supplies only the icons and the lazy `pele` loader. The API
 * reference blocks stay simplified here, because the published ones need the
 * renderer's reference layout.
 */

type PreviewProps = { children?: ReactNode }

/** The docs code fence, drawn with the dashboard's copy of the same Lucide glyphs. */
const PreviewPre = createPre({ copy: Copy, copied: Check })

// `pele` loads only when a page has a diagram, the same as on the published site.
const MermaidDiagram = lazy(() => import("pele").then(({ render }) => ({ default: createMermaid({ render }) })))

export function Mermaid(props: MermaidProps) {
  return (
    <Suspense fallback={null}>
      <MermaidDiagram {...props} />
    </Suspense>
  )
}

function ApiMethodBadge({ method }: { method?: string }) {
  return (
    <span className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.1em] text-primary uppercase">
      {method ?? "GET"}
    </span>
  )
}

function ApiEndpoint({
  method,
  path,
  children,
}: PreviewProps & { method?: string; path?: string; baseUrl?: string }) {
  return (
    <div className="not-prose mt-8">
      <div className="flex min-w-0 items-center gap-2.5 rounded-md border bg-card px-3 py-2">
        <ApiMethodBadge method={method} />
        <code className="min-w-0 overflow-x-auto font-mono text-[0.8125rem] whitespace-nowrap text-foreground">
          {path ?? "/"}
        </code>
      </div>
      {children}
    </div>
  )
}

function ApiParams({
  title,
  detail,
  children,
}: PreviewProps & { title?: string; detail?: string }) {
  return (
    <section className="not-prose mt-10">
      <div className="flex items-baseline justify-between gap-3 border-b pb-2">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {detail ? (
          <span className="font-mono text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  )
}

function ApiParam({
  name,
  type,
  required,
  children,
}: PreviewProps & { name?: string; type?: string; required?: boolean | string }) {
  return (
    <div className="border-t border-border/60 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code className="font-mono text-[0.8125rem] font-semibold break-all text-foreground">
          {name}
        </code>
        {type ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
            {type}
          </span>
        ) : null}
        {required ? (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[0.65rem] text-destructive">
            required
          </span>
        ) : null}
      </div>
      {children ? (
        <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground [&>p]:m-0 [&>p+p]:mt-2">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function SampleBlock({
  title,
  detail,
  children,
}: PreviewProps & { title: string; detail?: string }) {
  return (
    <section className="not-prose mt-6 overflow-hidden rounded-xl border bg-card/60">
      <header className="flex items-center gap-2 border-b bg-muted/40 py-1.5 pr-1.5 pl-3">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {title}
        </h3>
        {detail ? (
          <span className="font-mono text-[0.7rem] text-muted-foreground">{detail}</span>
        ) : null}
      </header>
      <div className="overflow-auto text-[0.8125rem] [&>div]:m-0 [&>div]:border-0 [&_pre]:m-0 [&_pre]:bg-transparent">
        {children}
      </div>
    </section>
  )
}

function ApiRequestExample({
  label,
  lang,
  children,
}: PreviewProps & { label?: string; lang?: string; client?: string }) {
  return (
    <SampleBlock title={label ?? "Request"} detail={lang}>
      {children}
    </SampleBlock>
  )
}

function ApiResponseExample({
  status,
  contentType,
  children,
}: PreviewProps & { status?: string | number; contentType?: string }) {
  return (
    <SampleBlock title={`Response ${status ?? ""}`.trim()} detail={contentType}>
      {children}
    </SampleBlock>
  )
}

/**
 * The docs renderer's icon roles, drawn with the dashboard's icon set. An
 * expanded folder shows the closed glyph there, so it does here too.
 */
export const PREVIEW_FILE_TREE_ICONS: FileTreeIcons = {
  folderOpen: FolderClosed,
  folderClosed: Folder,
  file: FileText,
}

export const PREVIEW_COMPONENT_OVERRIDES: Partial<ProseComponentMap> = {
  ApiEndpoint,
  ApiParam,
  ApiParams,
  ApiRequestExample,
  ApiResponseExample,
  Mermaid,
  pre: PreviewPre,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
}

/**
 * A page image. An `/assets/…` image may be unpublished, so it loads through
 * the branch with the user's session instead of from the docs host.
 */
function PreviewImage({ src, ...props }: ComponentProps<"img">) {
  const source = useImageSource(typeof src === "string" ? src : "")
  return source.url ? <img {...props} src={source.url} /> : null
}

export const PREVIEW_ELEMENT_OVERRIDES: ProseElementMap = {
  img: PreviewImage,
  table: ProseTable,
}
