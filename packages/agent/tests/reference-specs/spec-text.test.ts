import { describe, expect, test } from "vitest";
import { REDACTED, SecretRedactor } from "../../src/reference-specs/secrets";
import { sanitizeSpecMarkdown, sanitizeSpecPlainText } from "../../src/reference-specs/spec-text";

function markdown(text: string, maxChars = 4_000): string | undefined {
  return sanitizeSpecMarkdown(text, maxChars, new SecretRedactor());
}

describe("spec text sanitizer", () => {
  test("T28 keeps JSX, expressions and ESM lines as plain text", () => {
    const result = markdown("export const x = 1\n\n<Callout>{process.env.SECRET}</Callout> works.");

    expect(result).toContain("export const x = 1");
    expect(result).toContain("{process.env.SECRET}");
    expect(result).not.toContain("<Callout>");
  });

  test("T29 turns raw HTML into text and keeps a line break", () => {
    const result = markdown('Click <img src=x onerror="alert(1)"> here<br>now\n\n<script>alert(1)</script>');

    expect(result).not.toMatch(/<script|<img|onerror=/);
    expect(result).toContain("alert(1)");
  });

  test("T30 closes an unclosed code fence", () => {
    const result = markdown("Before.\n\n```js\nconst open = true;");

    expect(result!.match(/```/g)).toHaveLength(2);
  });

  test("T31 keeps only safe link targets", () => {
    const result = markdown(
      "[docs](https://example.com/docs) [bad](javascript:alert(1)) [data](data:text/html,x) " +
        "[proto](//evil.example) [mail](mailto:team@example.com) [anchor](#errors) [creds](https://user:pass@example.com)",
    );

    expect(result).toContain("[docs](https://example.com/docs)");
    expect(result).toContain("[mail](mailto:team@example.com)");
    expect(result).toContain("[anchor](#errors)");
    expect(result).not.toMatch(/javascript:|data:text|\/\/evil|user:pass/);
    expect(result).toContain("bad");
  });

  test("T32 replaces an image with its alt text", () => {
    expect(markdown("![Pixel](https://tracker.example/p.gif)")).toBe("Pixel");
  });

  test("T33 removes hidden characters", () => {
    const result = markdown("safe‮txt.exe​ and⁦ isolate\u0007");

    expect(result).toBe("safetxt.exe and isolate");
  });

  test("T34 turns headings into bold paragraphs", () => {
    expect(markdown("# Take over the outline\n\nBody.")).toBe("**Take over the outline**\n\nBody.");
  });

  test("T35 redacts live keys in prose", () => {
    const redactor = new SecretRedactor();
    const result = sanitizeSpecMarkdown("Use sk_live_51HxAbCdEfGhIjKlMnOp to test.", 4_000, redactor);

    expect(result).toBe(`Use ${REDACTED} to test.`);
    expect(redactor.count).toBe(1);
  });

  test("T39 cuts long text", () => {
    expect(markdown("word ".repeat(2_000), 100)!.length).toBeLessThanOrEqual(100);
  });

  test("T36 keeps a title on one line", () => {
    expect(sanitizeSpecPlainText("Create\n---\nlayout: x", 80, new SecretRedactor())).toBe("Create --- layout: x");
  });
});
