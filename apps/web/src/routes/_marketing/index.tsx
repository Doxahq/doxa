import { createFileRoute } from "@tanstack/react-router"
import { HomePage } from "~/components/marketing/home/home-page"

export const Route = createFileRoute("/_marketing/")({
  head: () => ({
    meta: [
      { title: "Doxa — Documentation that updates itself" },
      { name: "description", content: "Doxa writes your docs from the repository, rewrites them on every merge, and asks you before anything goes live. Open source and self-hostable." },
    ],
  }),
  component: HomePage,
})
