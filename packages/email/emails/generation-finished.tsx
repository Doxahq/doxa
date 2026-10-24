import type { GenerationFinishedEmailProps } from "../src/catalog/notifications";
import { EmailAction, EmailHeading, EmailNote, EmailParagraph } from "../src/components/email-blocks";
import { EmailLayout } from "../src/components/email-layout";

export function GenerationFinishedEmail({
  projectName,
  outcome,
  generationUrl,
  failureReason,
  unsubscribeUrl,
}: GenerationFinishedEmailProps) {
  const succeeded = outcome === "succeeded";
  return (
    <EmailLayout
      preview={succeeded ? `The docs for ${projectName} are ready to review.` : `The generation for ${projectName} failed.`}
      reason="You got this email because you started this generation."
      unsubscribeUrl={unsubscribeUrl}
    >
      <EmailHeading>{succeeded ? `Your docs for ${projectName} are ready` : `The generation for ${projectName} failed`}</EmailHeading>
      <EmailParagraph>
        {succeeded
          ? "Doxa finished the generation. Review the preview, then publish it when you are ready."
          : "Doxa could not finish the generation. Open it to see the steps that ran and start it again."}
      </EmailParagraph>
      {!succeeded && failureReason ? <EmailNote>Reason: {failureReason}</EmailNote> : null}
      <EmailAction href={generationUrl}>{succeeded ? "Review the docs" : "Open the generation"}</EmailAction>
    </EmailLayout>
  );
}

GenerationFinishedEmail.PreviewProps = {
  projectName: "Analytical Engines Docs",
  outcome: "succeeded",
  generationUrl: "https://doxa.so/dashboard/projects/example/generations/example",
  unsubscribeUrl: "https://doxa.so/email/unsubscribe?token=example",
} satisfies GenerationFinishedEmailProps;

export default GenerationFinishedEmail;
