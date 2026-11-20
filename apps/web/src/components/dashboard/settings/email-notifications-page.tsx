import { useQuery } from "@tanstack/react-query"

import { AccountPageFrame } from "~/components/dashboard/settings/account-page-frame"
import { EmailNotificationsSection } from "~/components/dashboard/settings/email-notifications-section"
import { EmailNotificationsSkeleton } from "~/components/dashboard/skeletons/account-skeletons"
import { ACCOUNT_PAGES } from "~/lib/dashboard/account-pages"
import { useIsFirstLoad } from "~/lib/dashboard/use-first-load"
import { billingAccountsQueryOptions } from "~/lib/queries/billing"
import { emailPreferencesQueryOptions } from "~/lib/queries/email-preferences"

/** `/dashboard/settings/notifications`: a switch for each kind of email that Doxa sends. */
export function EmailNotificationsPage() {
  // The billing accounts fill the Account sidebar's BILLING group, so it shows with the page.
  const isFirstLoad = useIsFirstLoad([
    useQuery(emailPreferencesQueryOptions()),
    useQuery(billingAccountsQueryOptions()),
  ])
  if (isFirstLoad) return <EmailNotificationsSkeleton />

  return (
    <AccountPageFrame page={ACCOUNT_PAGES.emailNotifications}>
      <EmailNotificationsSection />
    </AccountPageFrame>
  )
}
