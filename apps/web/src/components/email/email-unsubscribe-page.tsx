import { useMutation } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import { emailNotificationCategorySchema } from "@doxahq/contracts/email-preferences"

import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { Button } from "~/components/ui/button"
import { EMAIL_CATEGORY_COPY } from "~/lib/dashboard/email-preferences-model"
import { unsubscribeByLink } from "~/lib/email-preferences-api"
import { getErrorMessage } from "~/lib/errors"

export interface UnsubscribeLink {
  readonly user: string
  readonly category: string
  readonly token: string
}

/**
 * `/email/unsubscribe`: the page behind the footer link of a notification
 * email. Nothing changes until the person confirms, so a link scanner that
 * opens the page unsubscribes no one. It needs no session.
 */
export function EmailUnsubscribePage({ link }: { link: UnsubscribeLink }) {
  const category = emailNotificationCategorySchema.safeParse(link.category)
  const unsubscribe = useMutation({ mutationFn: () => unsubscribeByLink(link) })

  if (!category.success || !link.user || !link.token) {
    return (
      <AuthCard>
        <AuthCardHeading title="Link not valid" description="This unsubscribe link is incomplete. Open it again from the email." />
        <SettingsLink />
      </AuthCard>
    )
  }

  const copy = EMAIL_CATEGORY_COPY[category.data]
  if (unsubscribe.isSuccess) {
    return (
      <AuthCard>
        <AuthCardHeading
          title="Unsubscribed"
          description={`You will not get "${copy.title}" emails anymore. You can turn them on again in your settings.`}
        />
        <SettingsLink />
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <AuthCardHeading title={`Unsubscribe from ${copy.title.toLowerCase()} emails?`} description={copy.description} />
      <div className="flex w-full flex-col gap-3">
        <Button className="w-full" disabled={unsubscribe.isPending} onClick={() => unsubscribe.mutate()}>
          {unsubscribe.isPending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Unsubscribe
        </Button>
        {unsubscribe.error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {getErrorMessage(unsubscribe.error, "The link could not be used. Open it again from the email.")}
          </p>
        ) : null}
      </div>
    </AuthCard>
  )
}

function SettingsLink() {
  return (
    <Button variant="outline" asChild className="w-full">
      <Link to="/dashboard/settings">Open email settings</Link>
    </Button>
  )
}
