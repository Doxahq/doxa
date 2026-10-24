import { siteConfigJsonSchema, themeJsonSchema } from "../src/json-schema.ts";

console.log(
  JSON.stringify(
    { siteConfig: siteConfigJsonSchema(), theme: themeJsonSchema() },
    null,
    2,
  ),
);
