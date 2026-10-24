import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { PageMenu } from "@/src/components/sidebar/pagemenu";

describe("reference sidebar resource groups", () => {
  test("renders resource group headings in their supplied order", () => {
    const markup = renderToStaticMarkup(
      createElement(PageMenu, {
        variant: "reference",
        routes: [
          { heading: "System" },
          { spacer: true },
          { heading: "Environments" },
        ],
      })
    );

    expect(markup.indexOf("System")).toBeGreaterThan(-1);
    expect(markup.indexOf("Environments")).toBeGreaterThan(
      markup.indexOf("System")
    );
  });
});
