import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "@tanstack/react-router"

import { AuthBrandPanel } from "~/components/auth/auth-brand-panel"
import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { AuthField, AuthFooterLink, AuthMessage, AuthSubmit } from "~/components/auth/auth-form"
import { LogoMark } from "~/components/navigation/logo"
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, resetPassword } from "~/lib/auth/email-password"

/**
 * Sets a new password. The reset link in the email goes through the API, which
 * sends the person here with `?token=…`, or with `?error=INVALID_TOKEN` when
 * the link is used or expired.
 */
export function ResetPasswordPage({ token, linkError }: { token: string | null; linkError: boolean }) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get("password") ?? "")
    if (password !== String(form.get("confirm") ?? "")) {
      setError("The two passwords do not match.")
      return
    }
    setPending(true)
    setError(null)
    const result = await resetPassword(token, password)
    if (result.ok) {
      await navigate({ to: "/login", search: { notice: "password-reset" } })
      return
    }
    setPending(false)
    setError(result.message)
  }

  const usable = token !== null && !linkError

  return (
    <AuthCard aside={<AuthBrandPanel />}>
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="flex md:hidden">
          <LogoMark size={32} />
        </span>
        <AuthCardHeading
          title="New password"
          description={usable ? "Choose a new password for your Doxa account." : undefined}
        />
      </div>

      {usable ? (
        <div className="flex w-full flex-col gap-5">
          <form className="flex w-full flex-col gap-4" onSubmit={onSubmit}>
            <AuthField
              id="password"
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            />
            <AuthField
              id="confirm"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
            />
            <AuthSubmit pending={pending}>Set password</AuthSubmit>
          </form>
          {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
        </div>
      ) : (
        <AuthMessage tone="error">
          This reset link is not valid anymore. Links work once, for one hour.{" "}
          <Link to="/forgot-password" className="underline underline-offset-4">
            Ask for a new one
          </Link>
          .
        </AuthMessage>
      )}

      <AuthFooterLink>
        <Link to="/login">Back to sign in</Link>
      </AuthFooterLink>
    </AuthCard>
  )
}
