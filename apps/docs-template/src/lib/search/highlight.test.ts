import { describe, expect, test } from "vitest";
import { highlightTerms } from "./highlight";

describe("highlightTerms", () => {
  test("marks each term in any case", () => {
    expect(highlightTerms("Install the CLI, then install a plugin", ["install"])).toBe(
      '<mark class="search-highlight">Install</mark> the CLI, then <mark class="search-highlight">install</mark> a plugin',
    );
  });

  test.each(["amp", "lt", "gt", "quot", "39", "#"])(
    "marks nothing inside an entity when the term is %j",
    (term) => {
      // The raw text does not hold the term, so nothing gets a mark.
      expect(highlightTerms(`a & b < c > d " e ' f`, [term])).toBe(
        "a &amp; b &lt; c &gt; d &quot; e &#39; f",
      );
    },
  );

  test("escapes the text inside a mark", () => {
    expect(highlightTerms("<b>", ["<b>"])).toBe('<mark class="search-highlight">&lt;b&gt;</mark>');
  });

  test("escapes the text when no term is given", () => {
    expect(highlightTerms("<script>", [" "])).toBe("&lt;script&gt;");
  });
});
