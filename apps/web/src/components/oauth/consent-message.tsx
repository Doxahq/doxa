import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"

import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { LogoWordmark } from "~/components/navigation/logo"

export function ConsentCardHeader({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <LogoWordmark size={20} />
      <AuthCardHeading title={title} />
    </div>
  )
}

/** A card with one short status line, for the states around the consent forms. */
export function ConsentMessage({
  title,
  description,
  loading = false,
  action,
}: {
  title: string
  description: string
  loading?: boolean
  action?: ReactNode
}) {
  return (
    <AuthCard>
      <ConsentCardHeader title={title} />
      <div role="status" className="flex items-center gap-2.5 text-center text-sm text-muted-foreground">
        {loading ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
        <p>{description}</p>
      </div>
      {action}
    </AuthCard>
  )
}
