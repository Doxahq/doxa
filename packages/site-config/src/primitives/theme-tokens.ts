import { z } from "zod";
import { THEME_TOKEN_CSS_VARIABLES } from "../tokens";
import { cssColorSchema } from "./css-color";
import { cssLengthSchema } from "./css-length";

export const themeTokensSchema = z
  .object(
    Object.fromEntries(
      Object.keys(THEME_TOKEN_CSS_VARIABLES).map((key) => [
        key,
        key === "radius" ? cssLengthSchema : cssColorSchema,
      ]),
    ),
  )
  .strict();

export const themeTokenOverridesSchema = themeTokensSchema.partial();
