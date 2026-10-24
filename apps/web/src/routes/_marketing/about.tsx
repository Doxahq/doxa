import { createFileRoute } from "@tanstack/react-router"
import { AboutPage } from "~/components/marketing/about/about-page"

export const Route = createFileRoute("/_marketing/about")({
  head: () => ({
    meta: [
      { title: "About — Doxa" },
      { name: "description", content: "Doxa is an open-source docs platform from CoderOne Labs that you can self-host." },
    ],
  }),
  component: AboutPage,
})
