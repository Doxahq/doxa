import { z } from "zod";
import { siteConfigSchema } from "./schema/site-config";
import { themeFileSchema } from "./schema/theme";

export function siteConfigJsonSchema() {
  return {
    ...z.toJSONSchema(siteConfigSchema, { io: "input" }),
    $id: "https://doxa.so/schemas/site-config/v1.json",
  };
}

export function themeJsonSchema() {
  return {
    ...z.toJSONSchema(themeFileSchema, { io: "input" }),
    $id: "https://doxa.so/schemas/theme/v1.json",
  };
}
