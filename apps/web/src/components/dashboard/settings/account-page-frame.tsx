import type { ReactNode } from "react"

import { PageBody, PageHeading } from "~/components/dashboard/dashboard-header"
import { AccountTopBar } from "~/components/dashboard/shell/top-bar"
import type { AccountPage } from "~/lib/dashboard/account-pages"

/** The top bar and the heading of one account settings page, with the page content under them. */
export function AccountPageFrame({ page, children }: { page: AccountPage; children: ReactNode }) {
  return (
    <>
      <AccountTopBar crumbs={[page.title]} />
      <PageBody>
        <PageHeading label={page.group} title={page.title} description={page.description} />
        {children}
      </PageBody>
    </>
  )
}
