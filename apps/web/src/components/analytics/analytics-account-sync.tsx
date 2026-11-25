import { useDashboardAuth } from "~/lib/auth/dashboard-auth-context"
import { useAnalyticsAccount } from "~/lib/analytics/use-analytics-account"

/** Inside the dashboard: links analytics to the signed-in person and applies their account's switch. */
export function AnalyticsAccountSync() {
  const { user, isPending } = useDashboardAuth()
  useAnalyticsAccount(user && !isPending ? { id: user.id, email: user.email } : null)
  return null
}
