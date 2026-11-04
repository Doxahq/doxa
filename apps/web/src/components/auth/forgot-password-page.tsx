import { useState, type FormEvent } from "react"
import { Link } from "@tanstack/react-router"

import { AuthBrandPanel } from "~/components/auth/auth-brand-panel"
import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { AuthField, AuthFooterLink, AuthMessage, AuthSubmit } from "~/components/auth/auth-form"
import { LogoMark } from "~/components/navigation/logo"
import { requestPasswordReset } from "~/lib/auth/email-password"

/**
 * Asks for a password reset link. The page says the same thing whether or not
 * the address has an account, like the API.
 */
export function ForgotPasswordPage() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim()
    setPending(true)
    setError(null)
    const result = await requestPasswordReset(email)
    setPending(false)
    if (result.ok) setSentTo(email)
    else setError(result.message)
  }

  return (
    <AuthCard aside={<AuthBrandPanel />}>
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="flex md:hidden">
          <LogoMark size={32} />
        </span>
        <AuthCardHeading
          title="Reset password"
          description={
            sentTo ? (
              <>
                If <span className="text-foreground">{sentTo}</span> has a Doxa account, a reset link is on its way.
                It works for one hour.
              </>
            ) : (
              "Enter your email and we will send you a reset link."
            )
          }
        />
      </div>

      {sentTo ? null : (
        <div className="flex w-full flex-col gap-5">
          <form className="flex w-full flex-col gap-4" onSubmit={onSubmit}>
            <AuthField id="email" label="Email" type="email" autoComplete="email" required />
            <AuthSubmit pending={pending}>Send reset link</AuthSubmit>
          </form>
          {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
        </div>
      )}

      <AuthFooterLink>
        <Link to="/login">Back to sign in</Link>
      </AuthFooterLink>
    </AuthCard>
  )
}
