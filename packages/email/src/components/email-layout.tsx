import type { ReactNode } from "react";
import { Body, Container, Head, Hr, Html, Link, Preview, Section, Text } from "react-email";
import { EmailLogo } from "./email-logo";
import { emailBrand, emailTheme } from "./email-theme";
import { assertSafeLink } from "./safe-link";

export interface EmailLayoutProps {
  /** The inbox preview line, shown after the subject. */
  readonly preview: string;
  /** Why this person got the email, shown in the footer. */
  readonly reason: string;
  /** Notification emails link to their one-click unsubscribe page. */
  readonly unsubscribeUrl?: string;
  readonly children: ReactNode;
}

/** The frame of every Doxa email: logo, white card, and footer. */
export function EmailLayout({ preview, reason, unsubscribeUrl, children }: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        {/* The design is light only: ask mail clients not to recolor it in dark mode. */}
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <EmailLogo />
          <Section style={styles.card}>{children}</Section>
          <Hr style={styles.rule} />
          <Text style={styles.footer}>
            {reason}{" "}
            <Link href={emailBrand.url} style={styles.footerLink}>
              {emailBrand.url.replace(/^https:\/\//, "")}
            </Link>
          </Text>
          {unsubscribeUrl ? (
            <Text style={styles.footer}>
              <Link href={assertSafeLink(unsubscribeUrl)} style={styles.footerLink}>
                Unsubscribe from these emails
              </Link>
            </Text>
          ) : null}
        </Container>
      </Body>
    </Html>
  );
}

const { color, font, size } = emailTheme;

const styles = {
  body: { backgroundColor: color.page, fontFamily: font.sans, margin: 0, padding: "32px 0" },
  container: { maxWidth: size.cardWidth, margin: "0 auto", padding: "0 16px" },
  card: {
    backgroundColor: color.card,
    border: `1px solid ${color.border}`,
    borderRadius: 8,
    padding: "24px 24px 20px",
  },
  rule: { border: "none", borderTop: `1px solid ${color.border}`, margin: "20px 0 12px" },
  footer: { fontSize: 11, lineHeight: "16px", color: color.muted, margin: "0 0 4px" },
  footerLink: { color: color.muted, textDecoration: "underline" },
} as const;
