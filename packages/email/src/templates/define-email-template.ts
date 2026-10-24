import type { ReactElement } from "react";
import { render, toPlainText } from "react-email";
import type { EmailKind, EmailKindProps } from "../catalog/define-email-kind";

/**
 * How one email kind looks. The template knows nothing about the provider:
 * it gives a subject and a React element, and `renderEmailTemplate` turns
 * them into HTML and plain text.
 */
export interface EmailTemplate<Kind extends EmailKind = EmailKind> {
  readonly kind: Kind;
  subject(props: EmailKindProps<Kind>): string;
  render(props: EmailKindProps<Kind>): ReactElement;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function defineEmailTemplate<Kind extends EmailKind>(
  kind: Kind,
  parts: Omit<EmailTemplate<Kind>, "kind">,
): EmailTemplate<Kind> {
  return { kind, subject: parts.subject, render: parts.render };
}

/** Renders the HTML once and derives the plain-text part from it. */
export async function renderEmailTemplate<Kind extends EmailKind>(
  template: EmailTemplate<Kind>,
  props: EmailKindProps<Kind>,
): Promise<RenderedEmail> {
  const html = await render(template.render(props));
  return { subject: template.subject(props), html, text: toPlainText(html) };
}
