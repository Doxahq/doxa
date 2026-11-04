import { useState, type FormEvent } from "react"
import { Link } from "@tanstack/react-router"

import { AuthBrandPanel } from "~/components/auth/auth-brand-panel"
import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { AuthDivider, AuthField, AuthFooterLink, AuthLegalNote, AuthMessage, AuthSubmit } from "~/components/auth/auth-form"
import { ProviderButtons } from "~/components/auth/provider-buttons"
import { LogoMark } from "~/components/navigation/logo"
import { signInWithEmail, type AuthResult } from "~/lib/auth/email-password"

/** The sign-in card: GitHub, Google, or an email and password. */
export function LoginPage({
  redirectPath,
  errorMessage,
  notice,
}: {
  redirectPath: string
  errorMessage: string | null
  notice: string | null
}) {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<AuthResult | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    const next = await signInWithEmail({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirectPath,
    })
    if (next.ok) {
      // A full page load, like the session redirect of the `/login` route.
      window.location.assign(redirectPath)
      return
    }
    setResult(next)
    setPending(false)
  }

  // A form error replaces the message that the page opened with.
  const failed = result && !result.ok ? result : null
  const unverified = failed?.code === "EMAIL_NOT_VERIFIED"

  return (
    <AuthCard plain aside={<AuthBrandPanel />}>
      <div className="flex flex-col items-center gap-4 text-center">
        {/* From `md` up the brand panel beside the card shows the logo, so the card drops its own. */}
        <span className="flex md:hidden">
          <LogoMark size={32} />
        </span>
        <AuthCardHeading title="Sign in" description="Continue to your Doxa workspace." />
      </div>

      <div className="flex w-full flex-col gap-5">
        <ProviderButtons redirectPath={redirectPath} />
        <AuthDivider />

        <form className="flex w-full flex-col gap-4" onSubmit={onSubmit}>
          <AuthField id="email" label="Email" type="email" autoComplete="email" required />
          <AuthField id="password" label="Password" type="password" autoComplete="current-password" required />
          <AuthSubmit pending={pending}>Sign in</AuthSubmit>
        </form>

        {failed ? (
          <AuthMessage tone={unverified ? "notice" : "error"}>{failed.message}</AuthMessage>
        ) : errorMessage ? (
          <AuthMessage tone="error">{errorMessage}</AuthMessage>
        ) : notice ? (
          <AuthMessage tone="notice">{notice}</AuthMessage>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <AuthFooterLink>
          No account?{" "}
          <Link to="/signup" search={{ redirect: redirectPath }}>
            Sign up
          </Link>
        </AuthFooterLink>
        <AuthFooterLink>
          Forgot your password? <Link to="/forgot-password">Reset password</Link>
        </AuthFooterLink>
      </div>

      <AuthLegalNote />
    </AuthCard>
  )
}
