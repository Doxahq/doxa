import { RUNTIME_MDX_COMPONENT_NAMES } from "@doxahq/mdx-runtime";
import { describe, expect, test } from "vitest";

import { components } from "@/src/lib/components";

describe("runtime MDX component registry", () => {
  test("implements every canonical runtime component", () => {
    expect(new Set(Object.keys(components))).toEqual(
      new Set(RUNTIME_MDX_COMPONENT_NAMES)
    );
  });
});
