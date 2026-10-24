import { installStrictPublicFetch } from "./strict-public-fetch";

// The first import of main.ts, so the guard and the compatibility flag exist
// before the OAuth provider module loads and reads the flag. STRICT_PUBLIC_FETCH
// is "false" only in local development; config.ts reads the same variable.
if (process.env.STRICT_PUBLIC_FETCH !== "false") installStrictPublicFetch();
