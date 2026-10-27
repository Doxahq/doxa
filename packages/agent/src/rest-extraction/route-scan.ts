import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isProtectedFilePath } from "../core/tools/file-access-rules";
import { isHiddenPath, isSkippedPath } from "../repo-map/paths";
import { listProjectFiles } from "../utils/runtime";

/** A source file that registers routes, with the lines of its registrations. */
export interface RouteFile {
  path: string;
  text: string;
  /** 1-based lines that register a route; empty when the whole file is a route module. */
  routeLines: number[];
}

/** Source files a scan reads; a larger repository keeps the first by path. */
const MAX_SCANNED_FILES = 20_000;
/** A larger file is generated or vendored code, not a route module. */
const MAX_ROUTE_FILE_BYTES = 512 * 1024;

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|java|kt|rb|php|cs|rs)$/i;

/** One line that registers a route, in the common frameworks. */
const ROUTE_REGISTRATION_PATTERNS: readonly RegExp[] = [
  // Express, Hono, Fastify, Koa, Elysia: router.get("/users", ...)
  /\.\s*(?:get|post|put|patch|delete|options|head|all)\s*\(\s*["'`]\//i,
  // NestJS: @Get(":id"), @Post()
  /@(?:Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/,
  // Spring: @GetMapping, @RequestMapping
  /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/,
  // FastAPI, Flask: @app.get("/users"), @router.route("/x")
  /@\w+\.(?:get|post|put|patch|delete|route|api_route)\s*\(/,
  // Django: path("users/", ...), re_path(r"^users/$", ...)
  /\b(?:re_)?path\s*\(\s*r?["']/,
  // Gin, Echo, Chi, net/http: r.GET("/users", ...), mux.HandleFunc("/x", ...)
  /\.\s*(?:GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\s*\(\s*"\//,
  // ASP.NET: [HttpGet("users")], [Route("api/[controller]")]
  /\[(?:Http(?:Get|Post|Put|Patch|Delete)|Route)\b/,
  // Laravel: Route::get("/users", ...)
  /\bRoute::(?:get|post|put|patch|delete|any|match|resource|apiResource)\s*\(/,
  // Axum, Actix: .route("/users", get(list)), #[get("/users")]
  /\.\s*route\s*\(\s*"\//,
  /#\[(?:get|post|put|patch|delete)\s*\(\s*"/,
];

/** Files whose whole content is a route module: Next.js route handlers, Rails routes. */
const ROUTE_MODULE_PATH = /(?:^|\/)(?:app\/(?:.+\/)?route\.[cm]?[jt]s|pages\/api\/.+\.[cm]?[jt]sx?|config\/routes\.rb)$/;

/**
 * The source files of a checkout that register HTTP routes. A regex scan
 * marks each line that registers a route in Express, Hono, Fastify, Koa,
 * NestJS, Spring, FastAPI, Flask, Django, Gin, Echo, Chi, ASP.NET, Laravel,
 * Axum and Actix, and keeps Next.js route handlers and Rails routes whole.
 * Tests, fixtures and vendored code are left out.
 */
export async function scanRouteFiles(checkoutRoot: string): Promise<RouteFile[]> {
  const candidates = (await listProjectFiles(checkoutRoot))
    .filter((path) => SOURCE_EXTENSION.test(path) && !isSkippedPath(path) && !isHiddenPath(path))
    .sort()
    .slice(0, MAX_SCANNED_FILES);

  const files: RouteFile[] = [];
  for (const path of candidates) {
    const file = await readRouteFile(checkoutRoot, path);
    if (file) files.push(file);
  }
  return files;
}

/** A route file read from the checkout, or undefined when it registers no route. */
export async function readRouteFile(checkoutRoot: string, path: string): Promise<RouteFile | undefined> {
  if (isProtectedFilePath(path)) return undefined;
  const absolutePath = join(checkoutRoot, path);
  try {
    if ((await stat(absolutePath)).size > MAX_ROUTE_FILE_BYTES) return undefined;
    const text = await readFile(absolutePath, "utf8");
    return routeFileOf(path, text);
  } catch {
    return undefined;
  }
}

export function routeFileOf(path: string, text: string): RouteFile | undefined {
  if (ROUTE_MODULE_PATH.test(path)) return { path, text, routeLines: [] };
  const routeLines = text
    .split("\n")
    .flatMap((line, index) => (ROUTE_REGISTRATION_PATTERNS.some((pattern) => pattern.test(line)) ? [index + 1] : []));
  return routeLines.length > 0 ? { path, text, routeLines } : undefined;
}
