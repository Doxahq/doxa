import { createFileRoute } from "@tanstack/react-router"

import { DashboardLanding } from "~/components/dashboard/dashboard-landing"

export const Route = createFileRoute("/dashboard/")({
  component: DashboardLanding,
})
