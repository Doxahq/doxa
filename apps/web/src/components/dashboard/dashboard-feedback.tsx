import { AlertCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "~/components/ui/empty"

interface DashboardNoticeProps {
  message: string
  tone?: "muted" | "error"
  title?: string
}

export function DashboardNotice({
  message,
  tone = "muted",
  title = "Dashboard action failed",
}: DashboardNoticeProps) {
  if (tone === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Empty className="items-start border-border bg-background/40 p-3 text-left md:p-3">
      <EmptyHeader className="items-start text-left">
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
