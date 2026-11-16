import { createFileRoute } from "@tanstack/react-router"
import { AboutPage } from "~/components/marketing/about/about-page"
import { marketingHead } from "~/lib/marketing/seo"

export const Route = createFileRoute("/_marketing/about")({
  head: () =>
    marketingHead({
      path: "/about",
      title: "About — Doxa",
      description:
        "Doxa is an open-source documentation platform from CoderOne Labs. An AI agent keeps your docs true to your code, on our cloud or on your own servers.",
    }),
  component: AboutPage,
})
