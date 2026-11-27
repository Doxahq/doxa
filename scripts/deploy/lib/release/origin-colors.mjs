// The API origin runs as two ECS services, blue and green (blue/green). One
// serves the edge, the other is idle. A release starts the new image on the
// idle color, and the flip deploys an edge version that names that color.
// infra/terraform/modules/api-service uses the same names.

/** @typedef {"blue" | "green"} OriginColor */

/** @type {readonly OriginColor[]} */
export const ORIGIN_COLORS = Object.freeze(["blue", "green"]);

/** The edge variable that names the live color (apps/api-edge/src/origin.ts). */
export const ORIGIN_COLOR_VAR = "ORIGIN_COLOR";

/** @returns {value is OriginColor} */
export function isOriginColor(value) {
  return ORIGIN_COLORS.includes(value);
}

/** @param {OriginColor} color @returns {OriginColor} */
export function otherColor(color) {
  return color === "blue" ? "green" : "blue";
}

/**
 * The ECS service and task family of a color. Blue keeps the names of the
 * single service from before blue/green, so that service became blue
 * without a replacement. Green adds "-green".
 *
 * @param {string} baseName for example doxa-api-production
 * @param {OriginColor} color
 */
export function colorResourceName(baseName, color) {
  return color === "blue" ? baseName : `${baseName}-${color}`;
}

/**
 * The live color, from the variables of the edge version that serves
 * traffic. An edge from before blue/green has no ORIGIN_COLOR, and its
 * ORIGIN binding is the service that became blue.
 *
 * @param {Record<string, string>} edgeVars
 * @returns {OriginColor}
 */
export function liveColorOf(edgeVars) {
  const value = edgeVars[ORIGIN_COLOR_VAR];
  if (value === undefined) return "blue";
  if (!isOriginColor(value)) throw new Error(`The live edge names the origin color "${value}". Expected blue or green.`);
  return value;
}
