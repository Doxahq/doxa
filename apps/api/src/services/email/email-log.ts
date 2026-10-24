/** Structured email logs. They hold IDs and kinds, never addresses or props (email spec §9.5). */
export type EmailLogEvent =
  | "email_enqueued"
  | "email_enqueue_skipped"
  | "email_queue_send_failed"
  | "email_notification_failed"
  | "email_attempt_recorded"
  | "email_claim_lost"
  | "email_sweep"
  | "email_suppression_sync";

export type EmailLog = (event: EmailLogEvent, data: Readonly<Record<string, string | number | boolean | null>>) => void;

export const consoleEmailLog: EmailLog = (event, data) => {
  const line = JSON.stringify({ service: "doxa-api", event, ...data });
  if (event === "email_queue_send_failed" || event === "email_notification_failed") console.error(line);
  else console.log(line);
};
