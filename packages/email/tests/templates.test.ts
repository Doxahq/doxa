import { describe, expect, it } from "vitest";
import { EMAIL_KINDS, isNotificationCategory } from "../src/catalog";
import { EMAIL_TEMPLATES, findEmailTemplate, renderEmailTemplate, type EmailTemplate } from "../src/mailer-entry";

/** Each component's `PreviewProps` doubles as a valid fixture for its kind. */
async function previewPropsOf(name: string): Promise<unknown> {
  const module: { default: { PreviewProps?: unknown } } = await import(`../emails/${name}.tsx`);
  return module.default.PreviewProps;
}

describe("every email template", () => {
  it.each(EMAIL_KINDS.map((kind) => [kind.name]))("%s renders its preview props", async (name) => {
    const template: EmailTemplate | undefined = findEmailTemplate(name);
    const props = template?.kind.props.parse(await previewPropsOf(name));
    if (!template) throw new Error(`No template for ${name}.`);

    const rendered = await renderEmailTemplate(template, props);
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html).toContain("<!DOCTYPE html");
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it("shows the unsubscribe link on notification emails only (not on transactional or billing emails)", async () => {
    const templates: [string, EmailTemplate][] = Object.entries(EMAIL_TEMPLATES);
    for (const [name, template] of templates) {
      const props = template.kind.props.parse(await previewPropsOf(name));
      const { html } = await renderEmailTemplate(template, props);
      expect(html.includes("Unsubscribe from these emails")).toBe(isNotificationCategory(template.kind.category));
    }
  });
});
