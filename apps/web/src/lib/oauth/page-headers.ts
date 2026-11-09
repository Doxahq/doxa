/** No site may frame these pages, so a click on "Allow" is always the person's own. */
export const OAUTH_PAGE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
}
