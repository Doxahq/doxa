import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { routeFileOf, scanRouteFiles } from "../../src/rest-extraction/route-scan";
import { buildExtractionUnits, splitUnit } from "../../src/rest-extraction/units";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("route file scan", () => {
  test.each([
    ["Express", "src/routes.ts", 'router.get("/users", listUsers);'],
    ["Hono", "src/app.ts", "app.post('/users', (c) => c.json({}))"],
    ["NestJS", "src/users.controller.ts", "  @Get(':id')"],
    ["Spring", "src/UserController.java", "  @GetMapping(\"/users\")"],
    ["FastAPI", "app/main.py", "@router.get(\"/users\")"],
    ["Django", "app/urls.py", "    path(\"users/\", views.users),"],
    ["Gin", "main.go", "\tr.GET(\"/users\", listUsers)"],
    ["ASP.NET", "Controllers/Users.cs", "  [HttpGet(\"users\")]"],
    ["Laravel", "routes/api.php", "Route::get('/users', [UserController::class, 'index']);"],
    ["Axum", "src/main.rs", "    .route(\"/users\", get(list_users))"],
  ])("marks a route registration in %s", (_framework, path, line) => {
    expect(routeFileOf(path, `// header\n${line}\n`)?.routeLines).toEqual([2]);
  });

  test("keeps a Next.js route handler and Rails routes whole", () => {
    expect(routeFileOf("app/api/users/route.ts", "export async function GET() {}")).toMatchObject({ routeLines: [] });
    expect(routeFileOf("config/routes.rb", "resources :users")).toMatchObject({ routeLines: [] });
  });

  test("ignores a file that registers no route", () => {
    expect(routeFileOf("src/math.ts", "export const add = (a: number, b: number) => a + b;")).toBeUndefined();
  });

  test("skips tests, fixtures and vendored code", async () => {
    const root = await mkdtemp(join(tmpdir(), "doxa-route-scan-"));
    directories.push(root);
    const files = {
      "src/routes.ts": 'router.get("/users", list);',
      "tests/routes.test.ts": 'router.get("/users", list);',
      "vendor/lib/server.js": 'app.get("/x", handler);',
      "src/fixtures/app.ts": 'app.get("/x", handler);',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }

    expect((await scanRouteFiles(root)).map((file) => file.path)).toEqual(["src/routes.ts"]);
  });
});

describe("extraction units", () => {
  test("puts small files in one unit and numbers their lines", () => {
    const units = buildExtractionUnits([
      { path: "a.ts", text: 'app.get("/a", a);', routeLines: [1] },
      { path: "b.ts", text: 'app.get("/b", b);', routeLines: [1] },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]!.parts.map((part) => part.numberedText)).toEqual(['1| app.get("/a", a);', '1| app.get("/b", b);']);
  });

  test("splits a large file at its route registrations", () => {
    const handler = (name: string) => [`router.get("/${name}", (req, res) => {`, ...Array.from({ length: 30 }, () => "  work();"), "});"];
    const lines = [...handler("a"), ...handler("b"), ...handler("c")];
    const routeLines = [1, 33, 65];

    const units = buildExtractionUnits([{ path: "big.ts", text: lines.join("\n"), routeLines }], 600);

    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) {
      expect(unit.size).toBeLessThanOrEqual(600);
      expect(unit.parts[0]!.numberedText.split("\n")[0]).toMatch(/^\d+\| router\.get/);
    }
  });

  test("splits a unit in half by parts, then by lines", () => {
    const [unit] = buildExtractionUnits([
      { path: "a.ts", text: "a\nb\nc\nd", routeLines: [] },
      { path: "b.ts", text: "e", routeLines: [] },
    ]);
    const [first, second] = splitUnit(unit!)!;
    const [left, right] = splitUnit(first)!;

    expect([first.parts.map((part) => part.path), second.parts.map((part) => part.path)]).toEqual([["a.ts"], ["b.ts"]]);
    expect([left.parts[0]!.startLine, left.parts[0]!.endLine, right.parts[0]!.startLine]).toEqual([1, 2, 3]);
    expect(splitUnit(second)).toBeUndefined();
  });
});
