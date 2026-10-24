import { useEffect, useState, type ReactNode } from "react"
import { Github, Loader2 } from "lucide-react"

import { AuthBrandPanel } from "~/components/auth/auth-brand-panel"
import { AuthCard, AuthCardHeading } from "~/components/auth/auth-card"
import { Button } from "~/components/ui/button"
import { LogoMark } from "~/components/navigation/logo"
import { signInLink } from "~/lib/auth/sign-in-link"
import type { SignInProvider } from "~/lib/auth/use-auth-session"
import { cn } from "~/lib/utils"

/**
 * The sign-in card. Each provider button is a plain link to the API, so a
 * click works before the page hydrates. After hydration a click also shows a
 * spinner while the browser leaves for the provider.
 */
export function LoginPage({
  redirectPath,
  errorMessage,
}: {
  redirectPath: string
  errorMessage: string | null
}) {
  const [pendingProvider, setPendingProvider] = useState<SignInProvider | null>(null)

  // Back from the provider, the browser can restore this page from its cache
  // with the spinner still on.
  useEffect(() => {
    function resetOnRestore(event: PageTransitionEvent) {
      if (event.persisted) setPendingProvider(null)
    }
    window.addEventListener("pageshow", resetOnRestore)
    return () => window.removeEventListener("pageshow", resetOnRestore)
  }, [])

  return (
    <AuthCard aside={<AuthBrandPanel />}>
      <div className="flex flex-col items-center gap-4 text-center">
        {/* From `md` up the brand panel beside the card shows the logo, so the card drops its own. */}
        <span className="flex md:hidden">
          <LogoMark size={32} />
        </span>
        <AuthCardHeading title="Sign in" description="Continue to your Doxa workspace." />
      </div>

      <div className="flex w-full flex-col gap-2.5">
        <ProviderButton
          provider="github"
          redirectPath={redirectPath}
          pendingProvider={pendingProvider}
          onStart={setPendingProvider}
          icon={<Github />}
        >
          Continue with GitHub
        </ProviderButton>

        <ProviderButton
          provider="google"
          redirectPath={redirectPath}
          pendingProvider={pendingProvider}
          onStart={setPendingProvider}
          icon={<GoogleIcon />}
        >
          Continue with Google
        </ProviderButton>
      </div>

      {errorMessage ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}

      <p className="max-w-[16rem] text-center text-xs leading-5 text-muted-foreground">
        By continuing you agree to keep your docs in sync the Doxa way.
      </p>
    </AuthCard>
  )
}

function ProviderButton({
  provider,
  redirectPath,
  pendingProvider,
  onStart,
  icon,
  children,
}: {
  provider: SignInProvider
  redirectPath: string
  pendingProvider: SignInProvider | null
  onStart: (provider: SignInProvider) => void
  icon: ReactNode
  children: ReactNode
}) {
  const disabled = pendingProvider !== null

  return (
    <Button
      asChild
      variant="outline"
      className={cn("h-11 w-full", disabled && "pointer-events-none opacity-50")}
    >
      <a
        href={signInLink(provider, redirectPath)}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault()
            return
          }
          onStart(provider)
        }}
      >
        {pendingProvider === provider ? <Loader2 className="animate-spin" /> : icon}
        {children}
      </a>
    </Button>
  )
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("fill-current", className)}>
      <path d="M12 11v2.8h4.7c-.2 1.2-1.5 3.6-4.7 3.6a5.4 5.4 0 0 1 0-10.8c1.7 0 2.8.7 3.4 1.3l2.3-2.2A8.2 8.2 0 0 0 12 3a9 9 0 1 0 0 18c5.2 0 8.6-3.6 8.6-8.7 0-.6 0-1-.1-1.5H12Z" />
    </svg>
  )
}
