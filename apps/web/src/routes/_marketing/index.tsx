import { createFileRoute } from "@tanstack/react-router"
import { HomePage } from "~/components/marketing/home/home-page"
import { marketingHead } from "~/lib/marketing/seo"
import { organizationJsonLd, softwareApplicationJsonLd } from "~/lib/marketing/structured-data"

const HOME_DESCRIPTION =
  "Doxa writes your docs from the repository, rewrites them on every merge, and asks you before anything goes live. Open source and self-hostable."

export const Route = createFileRoute("/_marketing/")({
  head: () =>
    marketingHead({
      path: "/",
      title: "Doxa — Documentation that updates itself",
      description: HOME_DESCRIPTION,
      structuredData: [organizationJsonLd(), softwareApplicationJsonLd(HOME_DESCRIPTION)],
    }),
  component: HomePage,
})
