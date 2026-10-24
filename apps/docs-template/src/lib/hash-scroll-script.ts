import { DOCS_SCROLL_RESTORATION_ID } from "@/src/lib/docs-scroll";
import { APP_SCROLL_CONTAINER_ID } from "@/src/lib/toc";

/**
 * The router's session storage key for saved scroll positions. It is not
 * exported, so it is copied here. If a router update changes it, a refresh
 * restores the position after the app loads instead, as before this script.
 */
export const ROUTER_SCROLL_STORAGE_KEY = "tsr-scroll-restoration-v1_3";

/** The attribute that marks a TOC link, and the one that marks the current one. */
export const TOC_LINK_ATTRIBUTE = "data-toc-link";
export const TOC_ACTIVE_ATTRIBUTE = "data-active";

/**
 * Sets the docs scroll position and the current TOC item before the first
 * paint. Without it, a refresh paints the page at the top with no TOC item
 * marked, and both jump into place once the app has loaded.
 *
 * - A URL with a `#hash` lands on that heading. The router sets
 *   `history.scrollRestoration = "manual"`, so the browser does not do it.
 * - Any other refresh gets the position that the router saved for this
 *   history entry, which the router restores only after the app loads.
 * - The TOC item that the scroll spy will mark is marked now.
 *
 * Positions and the current item follow `scrollToHeading` and
 * `findActiveHeadingId` (`src/lib/toc.ts`): the same reading line, and the
 * same pressed triggers near the end of the page (`tocTriggers` and
 * `tocScrollTargets` in `@doxahq/docs-prose`). The test keeps them equal, so
 * the app finds the page already in place and does not move it.
 *
 * It runs inline, right after the scroll container in the server HTML.
 * Plain ES5, with no imports: it runs before any bundle loads.
 */
export const HASH_SCROLL_SCRIPT = `(function () {
  var TOLERANCE = 1;
  var FALLBACK_OFFSET = 80;
  var root = document.getElementById(${JSON.stringify(APP_SCROLL_CONTAINER_ID)});
  if (!root) return;

  var rootTop = root.getBoundingClientRect().top;
  function topOf(element) {
    return element.getBoundingClientRect().top - rootTop + root.scrollTop;
  }
  function marginOf(element) {
    return parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
  }
  var maxScroll = root.scrollHeight - root.clientHeight;

  var links = [];
  var headings = [];
  var found = root.querySelectorAll("a[${TOC_LINK_ATTRIBUTE}]");
  for (var i = 0; i < found.length; i++) {
    var heading = document.getElementById(found[i].getAttribute("href").slice(1));
    if (heading) {
      links.push(found[i]);
      headings.push(heading);
    }
  }

  var offset = FALLBACK_OFFSET;
  var tops = [];
  var triggers = [];
  if (headings.length) {
    var margin = marginOf(headings[0]);
    if (margin > 0) offset = margin;
    for (var j = 0; j < headings.length; j++) {
      tops.push(topOf(headings[j]));
      triggers.push(Math.max(0, tops[j] - offset));
    }
    var last = triggers[triggers.length - 1];
    if (maxScroll > TOLERANCE && last > maxScroll - TOLERANCE) {
      var end = maxScroll - TOLERANCE;
      var start = Math.max(0, end - Math.max(root.clientHeight - offset, 0));
      var scale = (end - start) / (last - start);
      for (var k = 0; k < triggers.length; k++) {
        if (triggers[k] > start) triggers[k] = start + (triggers[k] - start) * scale;
      }
    }
  }

  var active = -1;
  var hash = location.hash.slice(1);
  try { hash = decodeURIComponent(hash); } catch (error) {}
  var target = hash ? document.getElementById(hash) : null;
  if (target) {
    active = headings.indexOf(target);
    if (active === -1) {
      root.scrollTop = Math.max(0, Math.min(topOf(target) - marginOf(target), maxScroll));
    } else {
      var next = triggers[active + 1];
      var latest = next === undefined ? Infinity : (triggers[active] + next) / 2;
      var wanted = Math.min(tops[active] - offset, maxScroll);
      root.scrollTop = Math.max(triggers[active], Math.min(wanted, latest));
    }
  } else if (!hash) {
    try {
      var saved = JSON.parse(sessionStorage.getItem(${JSON.stringify(ROUTER_SCROLL_STORAGE_KEY)}) || "{}");
      var key = (history.state && history.state.__TSR_key) || location.pathname + location.search;
      var entry = saved[key] && saved[key]['[data-scroll-restoration-id="${DOCS_SCROLL_RESTORATION_ID}"]'];
      if (entry && typeof entry.scrollY === "number") root.scrollTop = entry.scrollY;
    } catch (error) {}
  }

  if (!links.length) return;
  if (active === -1) {
    active = 0;
    for (var m = 0; m < triggers.length; m++) {
      if (triggers[m] <= root.scrollTop + TOLERANCE) active = m;
    }
  }
  links[active].setAttribute("${TOC_ACTIVE_ATTRIBUTE}", "true");
})();`;
