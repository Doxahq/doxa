/**
 * How the docs renderer tells the gateway which scripts are its own (SEC-023).
 *
 * For each render, the renderer picks a new random mark. It writes the mark in
 * this attribute of the `<html>` tag, and in the `nonce` attribute of each
 * script that it writes. Page content is fixed before the render starts, so it
 * cannot hold the mark. The gateway reads the mark from the first `<html>` tag,
 * which comes before all page content.
 */
export const DOCS_SCRIPT_MARK_ATTRIBUTE = "data-doxa-script-mark";
