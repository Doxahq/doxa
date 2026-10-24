import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  HttpMethodBadge,
  SidebarNavMarker,
  sidebarNavTitle,
} from "@/src/components/sidebar/http-method-badge";

describe("REST sidebar method badges", () => {
  test.each([
    ["GET", "text-emerald-700"],
    ["POST", "text-sky-700"],
    ["PUT", "text-amber-700"],
    ["PATCH", "text-amber-700"],
    ["DELETE", "text-rose-700"],
  ])("renders %s with its method-specific treatment", (method, colorClass) => {
    const markup = renderToStaticMarkup(
      createElement(HttpMethodBadge, { method })
    );

    expect(markup).toContain(`>${method}</span>`);
    expect(markup).toContain(colorClass);
    expect(markup).toContain(`aria-label="${method} method"`);
  });

  test("uses the method chip instead of a configured catalog icon", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarNavMarker, { icon: "file", badge: "GET" })
    );

    expect(markup).toContain(">GET</span>");
    expect(markup).not.toContain("<svg");
  });

  test("keeps catalog icons for non-method badges", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarNavMarker, { icon: "file", badge: "Beta" })
    );

    expect(markup).toContain("<svg");
    expect(markup).not.toContain(">Beta</span>");
  });

  test("drops a legacy method-and-path prefix that the badge already shows", () => {
    expect(sidebarNavTitle("GET /health", "GET")).toBe("/health");
    expect(sidebarNavTitle("DELETE /v1/flags/{flagKey}", "DELETE")).toBe(
      "/v1/flags/{flagKey}"
    );
    expect(sidebarNavTitle("SDK client", "class")).toBe("SDK client");
  });

  test("keeps a leading verb that matches the method name", () => {
    expect(sidebarNavTitle("Delete a flag", "DELETE")).toBe("Delete a flag");
    expect(sidebarNavTitle("Get a flag", "GET")).toBe("Get a flag");
    expect(sidebarNavTitle("Get deployment status", "GET")).toBe(
      "Get deployment status"
    );
    expect(sidebarNavTitle("Post a comment", "POST")).toBe("Post a comment");
    expect(sidebarNavTitle("Health check", "GET")).toBe("Health check");
  });
});
