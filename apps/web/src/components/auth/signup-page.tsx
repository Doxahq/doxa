import { useState, type FormEvent } from "react"
import { Link } from "@tanstack/react-router"

import { AuthBrandPanel } from "~/components/auth/auth-brand-panel"
import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { AuthDivider, AuthField, AuthFooterLink, AuthLegalNote, AuthMessage, AuthSubmit } from "~/components/auth/auth-form"
import { ProviderButtons } from "~/components/auth/provider-buttons"
import { LogoMark } from "~/components/navigation/logo"
import { captureBrowserEvent } from "~/lib/analytics/capture-browser-event"
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  signUpWithEmail,
} from "~/lib/auth/email-password"

/**
 * The sign-up card: GitHub, Google, or a name, email and password. An email
 * sign-up ends on "Check your email": the account works after the person opens
 * the verification link. The API gives the same answer when the address
 * already has an account, so this page never says which addresses exist.
 */
export function SignupPage({ redirectPath }: { redirectPath: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get("email") ?? "").trim()
    captureBrowserEvent("signup_form_submitted", { method: "email" })
    setPending(true)
    setError(null)
    const result = await signUpWithEmail({
      name: String(form.get("name") ?? "").trim(),
      email,
      password: String(form.get("password") ?? ""),
      redirectPath,
    })
    setPending(false)
    if (result.ok) setSentTo(email)
    else setError(result.message)
  }

  return (
    <AuthCard plain aside={<AuthBrandPanel />}>
      <div className="flex flex-col items-center gap-4 text-center">
        {/* From `md` up the brand panel beside the card shows the logo, so the card drops its own. */}
        <span className="flex md:hidden">
          <LogoMark size={32} />
        </span>
        {sentTo ? (
          <AuthCardHeading
            title="Check your email"
            description={
              <>
                We sent a verification link to <span className="text-foreground">{sentTo}</span>. Open it to finish
                creating your account.
              </>
            }
          />
        ) : (
          <AuthCardHeading title="Sign up" description="Create your Doxa workspace." />
        )}
      </div>

      {sentTo ? (
        <AuthMessage tone="notice">
          No email after a few minutes? Check your spam folder, or sign in with your password to get a new link.
        </AuthMessage>
      ) : (
        <div className="flex w-full flex-col gap-5">
          <ProviderButtons
            redirectPath={redirectPath}
            onStart={(provider) => captureBrowserEvent("signup_form_submitted", { method: provider })}
          />
          <AuthDivider />

          <form className="flex w-full flex-col gap-4" onSubmit={onSubmit}>
            <AuthField id="name" label="Name" type="text" autoComplete="name" required maxLength={120} />
            <AuthField id="email" label="Email" type="email" autoComplete="email" required />
            <AuthField
              id="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            />
            <AuthSubmit pending={pending}>Create account</AuthSubmit>
          </form>

          {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
        </div>
      )}

      <AuthFooterLink>
        {sentTo ? "Verified already?" : "Have an account?"}{" "}
        <Link to="/login" search={{ redirect: redirectPath }}>
          Sign in
        </Link>
      </AuthFooterLink>

      {sentTo ? null : <AuthLegalNote />}
    </AuthCard>
  )
}
