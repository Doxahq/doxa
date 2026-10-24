import { ShieldCheck } from "lucide-react"
import type { ReactNode } from "react"

import { SwitchRow } from "~/components/dashboard/content/site-settings/fields/controls"
import { Button } from "~/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog"
import { usePageLocks } from "~/lib/dashboard/use-page-locks"

/** The page whose settings the dialog shows. */
export interface PageSettingsTarget {
  href: string
  title: string
}

/**
 * The settings of one page. For now it holds one section, Agent, with one
 * switch: lock the page from generations, so they keep it as published.
 * Every page starts unlocked. The switch saves as soon as it changes.
 */
export function PageSettingsDialog(props: {
  projectId: string
  /** Null closes the dialog. */
  page: PageSettingsTarget | null
  onClose: () => void
}) {
  const locks = usePageLocks(props.projectId)
  const { page } = props

  return (
    <Dialog open={page !== null} onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent className="shadow-none">
        <DialogHeader>
          <DialogTitle>Page settings</DialogTitle>
          <DialogDescription className="text-pretty">
            <span className="font-medium text-foreground">{page?.title}</span>{" "}
            <span className="font-mono text-[12px]">{page?.href}</span>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <PageSettingsSection
            title="Agent"
            description="What generations may do to this page."
          >
            {page ? (
              <SwitchRow
                id="page-agent-lock"
                title="Lock from generations"
                description="Generations keep this page exactly as published. You can still edit it. Leave it unlocked to let them update the page when its code or evidence changes, even after your own edits."
                checked={locks.isLocked(page.href)}
                disabled={locks.isLoading || locks.updatingHref === page.href}
                onCheckedChange={(locked) => locks.setLocked(page.href, locked)}
              />
            ) : null}
            <p className="flex items-start gap-2.5 rounded-md bg-primary-wash px-3 py-2.5 text-[13px] leading-5 text-pretty text-body">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary-text" />
              You always review a generation's changes before anything goes live, whether a page is locked or not.
            </p>
          </PageSettingsSection>
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One group of page settings: a mono heading, a short description, then its fields. */
function PageSettingsSection(props: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-label={props.title} className="flex flex-col gap-4">
      <header className="space-y-1">
        <h3 className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">{props.title}</h3>
        <p className="text-[13px] leading-5 text-muted-foreground">{props.description}</p>
      </header>
      {props.children}
    </section>
  )
}
