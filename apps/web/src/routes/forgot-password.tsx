import { createFileRoute } from "@tanstack/react-router"

import { ForgotPasswordPage } from "~/components/auth/forgot-password-page"

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Forgot password — Doxa" }] }),
  component: ForgotPasswordPage,
})
