import { createPre } from "@doxahq/docs-prose";
import { LuCheck, LuCopy } from "react-icons/lu";

/**
 * The code fence of the published docs. The markup lives in
 * `@doxahq/docs-prose`, so the dashboard editor draws the same block.
 */
const Pre = createPre({ copy: LuCopy, copied: LuCheck });

export default Pre;
