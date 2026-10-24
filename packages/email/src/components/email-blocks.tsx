import type { ReactNode } from "react";
import { Button, Column, Heading, Row, Section, Text } from "react-email";
import { emailTheme } from "./email-theme";
import { assertSafeLink } from "./safe-link";

const { color, font } = emailTheme;

export function EmailHeading({ children }: { readonly children: ReactNode }) {
  return (
    <Heading as="h1" style={{ fontSize: 18, lineHeight: "26px", fontWeight: 600, color: color.text, margin: "0 0 12px" }}>
      {children}
    </Heading>
  );
}

export function EmailParagraph({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={{ fontFamily: font.sans, fontSize: 14, lineHeight: "22px", color: color.text, margin: "0 0 16px" }}>
      {children}
    </Text>
  );
}

/** Small, muted text, such as an expiry date or a "you can ignore this email" note. */
export function EmailNote({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={{ fontFamily: font.sans, fontSize: 12, lineHeight: "18px", color: color.muted, margin: "16px 0 0" }}>
      {children}
    </Text>
  );
}

export interface EmailFact {
  readonly label: string;
  readonly value: string;
}

/** Label and value rows, such as Project, Action and Agent. */
export function EmailFacts({ facts }: { readonly facts: readonly EmailFact[] }) {
  return (
    <Section style={{ border: `1px solid ${color.border}`, borderRadius: 6, padding: "2px 12px", margin: "0 0 16px" }}>
      {facts.map((fact) => (
        <Row key={fact.label}>
          <Column style={{ width: 128, verticalAlign: "top", paddingRight: 12 }}>
            <Text style={{ ...factText, fontFamily: font.mono, fontSize: 10, color: color.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {fact.label}
            </Text>
          </Column>
          <Column style={{ verticalAlign: "top" }}>
            <Text style={{ ...factText, fontSize: 13, color: color.text }}>{fact.value}</Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}

const factText = { fontFamily: font.sans, lineHeight: "18px", margin: "6px 0" } as const;

export interface EmailActionProps {
  readonly href: string;
  readonly children: ReactNode;
}

/** The main call to action. Only `https:` links (and `http:` to localhost) are allowed. */
export function EmailAction({ href, children }: EmailActionProps) {
  return (
    <Section style={{ margin: "8px 0 8px" }}>
      <Button
        href={assertSafeLink(href)}
        style={{
          backgroundColor: color.accent,
          color: color.accentText,
          fontFamily: font.sans,
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 6,
          padding: "8px 14px",
          textDecoration: "none",
        }}
      >
        {children}
      </Button>
    </Section>
  );
}
