import type { DomainStatusChangedEmailProps } from "../src/catalog/notifications";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function DomainStatusChangedEmail({
  projectName,
  hostname,
  status,
  domainsUrl,
  failureReason,
  unsubscribeUrl,
}: DomainStatusChangedEmailProps) {
  const active = status === "active";
  return (
    <EmailLayout
      preview={active ? `${hostname} now serves the docs of ${projectName}.` : `${hostname} could not be connected.`}
      reason="You got this email because you can manage domains in this project."
      unsubscribeUrl={unsubscribeUrl}
    >
      <EmailHeading>{active ? `${hostname} is live` : `${hostname} needs attention`}</EmailHeading>
      <EmailParagraph>
        {active
          ? `The domain now serves the published docs of ${projectName} with HTTPS.`
          : `Doxa could not connect the domain to ${projectName}. Check the DNS records, then check the domain again.`}
      </EmailParagraph>
      {!active && failureReason ? <EmailNote>Reason: {failureReason}</EmailNote> : null}
      <EmailAction href={domainsUrl}>Open domain settings</EmailAction>
    </EmailLayout>
  );
}

DomainStatusChangedEmail.PreviewProps = {
  projectName: "Analytical Engines Docs",
  hostname: "docs.analytical-engines.dev",
  status: "active",
  domainsUrl: "https://doxa.so/dashboard/projects/example/site/domains",
  unsubscribeUrl: "https://doxa.so/email/unsubscribe?token=example",
} satisfies DomainStatusChangedEmailProps;

export default DomainStatusChangedEmail;
