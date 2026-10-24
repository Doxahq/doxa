/** The delivery side: React templates and the mailer. Import it only in the Worker that sends email. */
export { Mailer, TEMPLATE_HEADER, type EmailEnvelope, type MailerDeps } from "./mailer";
export {
  EMAIL_TEMPLATES,
  approvalDecidedTemplate,
  approvalRequestedTemplate,
  defineEmailTemplate,
  domainStatusChangedTemplate,
  findEmailTemplate,
  generationFinishedTemplate,
  renderEmailTemplate,
  teamInviteTemplate,
  type EmailTemplate,
  type RenderedEmail,
} from "./templates";
