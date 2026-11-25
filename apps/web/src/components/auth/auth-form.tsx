import type { ComponentProps, ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"

import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { Label } from "~/components/ui/label"
import { PrivacyChoicesButton } from "~/components/analytics/privacy-choices"
import { cn } from "~/lib/utils"

/** A labeled input of an auth form. */
export function AuthField({ id, label, ...input }: ComponentProps<typeof Input> & { id: string; label: string }) {
  return (
    <div className="flex flex-col gap-2 text-left">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} className="h-11" {...input} />
    </div>
  )
}

/** The primary button of an auth form, with a spinner while the request runs. */
export function AuthSubmit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" className="h-11 w-full" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : null}
      {children}
    </Button>
  )
}

/** The rule with "or" between the provider buttons and the email form. */
export function AuthDivider() {
  return (
    <div className="flex w-full items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** An error (`role="alert"`) or a neutral notice, such as "Check your email". */
export function AuthMessage({ tone, children }: { tone: "error" | "notice"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "w-full rounded-md px-3 py-2.5 text-center text-sm leading-5",
        tone === "error" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-foreground",
      )}
    >
      {children}
    </p>
  )
}

/** The small link line under a card, such as "No account? Sign up". */
export function AuthFooterLink({ children }: { children: ReactNode }) {
  return (
    <p className="text-center text-sm text-muted-foreground [&_a]:text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline">
      {children}
    </p>
  )
}

/** The note at the bottom of the login and signup pages that links to the legal pages and to Privacy choices. */
export function AuthLegalNote() {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="max-w-[18rem] text-center text-xs leading-5 text-muted-foreground [&_a]:text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline">
        By continuing you agree to the <Link to="/legal/terms">Terms of Service</Link> and the{" "}
        <Link to="/legal/privacy">Privacy Policy</Link>.
      </p>
      <PrivacyChoicesButton className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" />
    </div>
  )
}
