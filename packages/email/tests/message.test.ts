import { describe, expect, it } from "vitest";
import { findEmailMessageProblem, parseEmailAddress, type EmailMessage } from "../src";

const valid: EmailMessage = {
  from: { address: "no-reply@notification.doxa.so" },
  to: [{ address: "ada@example.com" }],
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
};

describe("findEmailMessageProblem", () => {
  it("accepts a valid message", () => {
    expect(findEmailMessageProblem(valid)).toBeNull();
  });

  it.each([
    ["no recipient", { to: [] }, "to"],
    ["a bad address", { to: [{ address: "not-an-email" }] }, "to.0.address"],
    ["a subject with a line break", { subject: "Hi\r\nBcc: x@example.com" }, "subject"],
    ["an empty text part", { text: "" }, "text"],
    ["a header name with an underscore", { headers: { X_Bad: "1" } }, "headers.X_Bad"],
    ["a header value with a line break", { headers: { "X-Doxa": "a\nb" } }, "headers.X-Doxa"],
    ["a display name with a quote", { from: { address: "a@example.com", name: 'A"B' } }, "from.name"],
  ] as const)("refuses %s", (_label, change, path) => {
    expect(findEmailMessageProblem({ ...valid, ...change })).toMatch(new RegExp(`^${path}: `));
  });

  it("refuses more than 50 recipients across to, cc and bcc", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ address: `user${index}@example.com` }));
    expect(findEmailMessageProblem({ ...valid, to: many, cc: many })).toBeNull();
    expect(findEmailMessageProblem({ ...valid, to: many, cc: many, bcc: [{ address: "x@example.com" }] })).toMatch(
      /more than 50 recipients/,
    );
  });
});

describe("parseEmailAddress", () => {
  it.each([
    ["no-reply@notification.doxa.so", { address: "no-reply@notification.doxa.so" }],
    ["Doxa <no-reply@notification.doxa.so>", { address: "no-reply@notification.doxa.so", name: "Doxa" }],
    ['"Doxa Team" <team@doxa.so>', { address: "team@doxa.so", name: "Doxa Team" }],
    ["  <team@doxa.so>  ", { address: "team@doxa.so" }],
  ])("reads %s", (value, expected) => {
    expect(parseEmailAddress(value)).toEqual(expected);
  });

  it.each(["", "Doxa", "a@b.co, c@d.co", "Doxa <not-an-email>"])("refuses %j", (value) => {
    expect(() => parseEmailAddress(value)).toThrow(/not one valid email address/);
  });
});
