import type { EmailNotificationCategory } from "@doxahq/contracts/email-preferences"

/** What each notification category sends, in the words of the settings page. */
export const EMAIL_CATEGORY_COPY: Readonly<Record<EmailNotificationCategory, { title: string; description: string }>> = {
  approvals: {
    title: "Approval requests",
    description: "When an agent asks for an action that you can approve, and when someone decides on your agent's request.",
  },
  generations: {
    title: "Generations",
    description: "When a generation that you started finishes or fails.",
  },
  domains: {
    title: "Custom domains",
    description: "When a custom domain that you manage goes live or needs attention.",
  },
}
