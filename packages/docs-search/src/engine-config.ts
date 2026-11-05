/**
 * The MiniSearch setup that every index uses. A serialized index stores no
 * options, so the writer and each reader must use this one definition.
 */
export const SEARCH_FIELD_CONFIG = {
  idField: "id",
  fields: ["title", "headingsText", "keywordsText", "content"],
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
    combineWith: "AND" as const,
    boost: {
      title: 5,
      headingsText: 3,
      keywordsText: 2,
      content: 1,
    },
  },
};
