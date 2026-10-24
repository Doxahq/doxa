import { Column, Img, Link, Row, Section, Text } from "react-email";
import { emailBrand, emailTheme } from "./email-theme";

/**
 * The full Doxa logo: the mark beside the "DOXA" wordmark, as on the website
 * (`LogoWordmark` in apps/web). The wordmark is text, so the brand still shows
 * when a mail client blocks images.
 */
export function EmailLogo() {
  const { logo } = emailBrand;
  return (
    <Section style={{ margin: "0 0 16px" }}>
      <Link href={emailBrand.url} style={{ textDecoration: "none" }}>
        <Row style={{ width: "auto" }}>
          <Column style={{ width: logo.width, verticalAlign: "middle", paddingRight: 8 }}>
            <Img src={logo.url} width={logo.width} height={logo.height} alt={emailBrand.name} style={{ display: "block" }} />
          </Column>
          <Column style={{ verticalAlign: "middle" }}>
            <Text style={wordmark}>{emailBrand.name.toUpperCase()}</Text>
          </Column>
        </Row>
      </Link>
    </Section>
  );
}

const wordmark = {
  fontFamily: emailTheme.font.mono,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: "24px",
  letterSpacing: "0.2em",
  color: emailTheme.color.text,
  margin: 0,
} as const;
