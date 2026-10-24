import { describe, expect, test } from "vitest";
import { lexicalSymbolExtractor } from "../src/repo-map/extractors";
import { detectLanguage, syntaxFor } from "../src/repo-map/languages";
import { maskSource } from "../src/repo-map/mask";
import type { FileExtraction, RepoSymbol } from "../src/repo-map/types";

function extract(path: string, content: string): FileExtraction {
  const language = detectLanguage(path);
  if (!language) throw new Error(`No language for ${path}`);
  return lexicalSymbolExtractor.extract({ path, language, content });
}

function names(extraction: FileExtraction, filter: (symbol: RepoSymbol) => boolean = () => true): string[] {
  return extraction.symbols.filter(filter).map((symbol) => symbol.name);
}

function exportedNames(extraction: FileExtraction): string[] {
  return names(extraction, (symbol) => symbol.exported).sort();
}

function specifiers(extraction: FileExtraction): string[] {
  return extraction.imports.map((entry) => entry.specifier);
}

describe("source masking", () => {
  test("blanks comments and string bodies without moving offsets", () => {
    const source = 'const a = "x // y"; // export function fake() {}\n/* class Hidden */ let b = `t ${c} u`;';
    const masked = maskSource(source, syntaxFor("typescript", "a.ts"));

    expect(masked).toHaveLength(source.length);
    expect(masked).not.toContain("fake");
    expect(masked).not.toContain("Hidden");
    expect(masked).toContain('"      "');
    // Template expressions stay code; template text does not.
    expect(masked).toContain("${c}");
    expect(masked).not.toMatch(/`t/);
  });

  test("keeps division and blanks regular expression literals", () => {
    const source = "const r = /export class X/g; const d = a / b / c;";
    const masked = maskSource(source, syntaxFor("javascript", "a.js"));
    expect(masked).not.toContain("export class X");
    expect(masked).toContain("a / b / c");
  });

  test("handles Rust lifetimes, char literals, raw strings, and nested comments", () => {
    const source = "fn f<'a>(x: &'a str) -> char { '{' }\nlet s = r#\"pub fn fake() {}\"#;\n/* outer /* inner */ pub fn hidden() {} */";
    const masked = maskSource(source, syntaxFor("rust", "lib.rs"));
    expect(masked).toContain("fn f<'a>(x: &'a str)");
    expect(masked).not.toContain("'{'");
    expect(masked).not.toContain("fake");
    expect(masked).not.toContain("hidden");
  });
});

describe("TypeScript and JavaScript extraction", () => {
  test("finds exports and ignores declarations in comments and strings", () => {
    const extraction = extract("src/client.ts", `
// export function commented() {}
const text = "export class InString {}";
/**
 * export const inDoc = 1;
 */
export function createClient(options: Options) {}
export async function* streamEvents() {}
export class Client {}
export abstract class BaseStore {}
export const DEFAULT_TIMEOUT = 30_000;
export const handler = async (request: Request) => new Response();
export type Options = { timeout?: number };
export interface Transport {}
export enum Mode { A, B }
export const enum Flag { On }
export declare namespace Internal {}
function helper() {}
`);

    expect(exportedNames(extraction)).toEqual([
      "BaseStore", "Client", "DEFAULT_TIMEOUT", "Flag", "Internal", "Mode",
      "Options", "Transport", "createClient", "handler", "streamEvents",
    ]);
    expect(names(extraction)).not.toContain("commented");
    expect(names(extraction)).not.toContain("InString");
    expect(names(extraction)).not.toContain("inDoc");
    expect(extraction.symbols.find((symbol) => symbol.name === "helper")).toMatchObject({
      kind: "function",
      exported: false,
    });
    expect(extraction.symbols.find((symbol) => symbol.name === "handler")?.kind).toBe("function");
    expect(extraction.symbols.find((symbol) => symbol.name === "DEFAULT_TIMEOUT")?.kind).toBe("const");
  });

  test("records re-exports, export lists, and their import edges", () => {
    const extraction = extract("src/index.ts", `
import { thing } from "./thing";
import type { Shape } from './shape.js';
import "./side-effect";
export * from "./core";
export * as utils from "./utils";
export { run, stream as streamRun } from "./agent";
export type { AgentOptions } from "./types";
const local = 1;
export { local, thing as renamed };
const lazy = () => import("./lazy");
const legacy = require("./legacy");
`);

    expect(specifiers(extraction)).toEqual([
      "./agent", "./core", "./lazy", "./legacy", "./shape.js", "./side-effect", "./thing", "./types", "./utils",
    ]);
    const reexports = names(extraction, (symbol) => symbol.kind === "reexport");
    expect(reexports).toEqual(expect.arrayContaining([
      "* from ./core", "utils", "run", "streamRun", "AgentOptions",
    ]));
    expect(exportedNames(extraction)).toEqual(expect.arrayContaining(["local", "renamed"]));
  });

  test("handles default exports in every form", () => {
    expect(exportedNames(extract("a.ts", "export default function Page() {}"))).toEqual(["Page"]);
    expect(exportedNames(extract("b.ts", "export default class Store {}"))).toEqual(["Store"]);
    expect(exportedNames(extract("c.ts", "export default function () {}"))).toEqual(["default"]);
    expect(exportedNames(extract("d.ts", "export default { fetch() {} };"))).toEqual(["default"]);
    const named = extract("e.ts", "function App() {}\nexport default App;\n");
    expect(exportedNames(named)).toEqual(["App"]);
  });

  test("finds routes with URL paths only", () => {
    const extraction = extract("src/server.js", `
app.get("/health", (c) => c.text("ok"));
router.post('/v1/projects', create);
api.delete(\`/v1/projects/:id\`, remove);
app.get("not-a-path", noop);
map.get("/looks-like-a-route-but-is-a-map");
`);
    expect(names(extraction, (symbol) => symbol.kind === "route")).toEqual([
      "GET /health", "POST /v1/projects", "DELETE /v1/projects/:id",
    ]);
  });

  test("finds CommonJS exports", () => {
    const extraction = extract("lib/index.cjs", "function parse() {}\nexports.parse = parse;\nmodule.exports.format = () => {};\n");
    expect(exportedNames(extraction)).toEqual(["format", "parse"]);
  });

  test("ignores nested declarations", () => {
    const extraction = extract("src/a.ts", "export function outer() {\n  function inner() {}\n  class Local {}\n}\n");
    expect(names(extraction)).toEqual(["outer"]);
  });
});

describe("Python extraction", () => {
  test("finds functions, classes, public methods, and decorated definitions", () => {
    const extraction = extract("app/service.py", `
"""Module docstring.
def not_a_function():
"""
import os
from typing import Optional

# def commented(): pass

@dataclass
class Client:
    """Docstring with class Fake: inside."""

    @property
    def name(self) -> str:
        def nested():
            pass
        return "def fake(): pass"

    def _private(self):
        pass

    async def fetch(self, url):
        pass

@lru_cache(maxsize=1)
def get_settings():
    pass

async def main():
    pass

def _helper():
    pass

if True:
    def conditional():
        pass
`);

    expect(exportedNames(extraction)).toEqual([
      "Client", "Client.fetch", "Client.name", "get_settings", "main",
    ]);
    expect(names(extraction)).not.toContain("not_a_function");
    expect(names(extraction)).not.toContain("commented");
    expect(names(extraction)).not.toContain("Client.nested");
    expect(names(extraction)).not.toContain("Client.conditional");
    expect(extraction.symbols.find((symbol) => symbol.name === "_helper")?.exported).toBe(false);
  });

  test("respects __all__ and reads route decorators", () => {
    const extraction = extract("api/routes.py", `
__all__ = ["create_user", "router"]

router = APIRouter()

@router.get("/users/{user_id}")
async def read_user(user_id: int):
    pass

@router.post(
    "/users",
    status_code=201,
)
def create_user():
    pass

@app.route("/legacy", methods=["GET"])
def legacy():
    pass
`);

    expect(exportedNames(extraction)).toEqual([
      "/legacy", "GET /users/{user_id}", "POST /users", "create_user",
    ]);
  });

  test("records absolute and relative imports with imported names", () => {
    const extraction = extract("pkg/a.py", `
import os, sys as system
import pkg.models
from . import utils
from .core import (
    Engine,
    run as start,
)
from ..shared.config import Settings
`);
    expect(extraction.imports).toEqual([
      { specifier: ".", names: ["utils"] },
      { specifier: "..shared.config", names: ["Settings"] },
      { specifier: ".core", names: ["Engine", "run"] },
      { specifier: "os" },
      { specifier: "pkg.models" },
      { specifier: "sys" },
    ]);
  });
});

describe("Go extraction", () => {
  test("finds functions, methods, grouped types, and exported values", () => {
    const extraction = extract("internal/server/server.go", `
package server

import (
	"context"
	chi "github.com/go-chi/chi/v5"
	"github.com/acme/app/internal/store"
)

// func Commented() {}
const Version = "1.0"
const internalLimit = 10

var (
	ErrNotFound = errors.New("not found")
	defaultPort = 8080
)

type (
	Config struct {
		Addr string
		Fields Thing
	}
	Handler interface {
		Serve()
	}
)

type Server struct{}
type Option func(*Server)
type List[T any] struct{}

func New(cfg Config, opts ...Option) *Server { return nil }
func (s *Server) Start(ctx context.Context) error { return nil }
func (s Server) stop() {}
func (l *List[T]) Push(v T) {}
func helper() {}
func init() {}
var text = \`func Fake() {}\`
`);

    expect(exportedNames(extraction)).toEqual([
      "Config", "ErrNotFound", "Handler", "List", "List.Push", "New", "Option", "Server", "Server.Start", "Version",
    ]);
    expect(names(extraction)).not.toContain("Commented");
    expect(names(extraction)).not.toContain("Fake");
    expect(names(extraction)).not.toContain("Addr");
    expect(names(extraction)).not.toContain("init");
    expect(names(extraction)).toContain("Server.stop");
    expect(specifiers(extraction)).toEqual([
      "context", "github.com/acme/app/internal/store", "github.com/go-chi/chi/v5",
    ]);
  });

  test("finds HTTP routes", () => {
    const extraction = extract("main.go", `
package main
func main() {
	http.HandleFunc("/healthz", health)
	r.Get("/users/{id}", getUser)
	e.POST("/users", createUser)
	header.Get("Content-Type")
}
`);
    expect(names(extraction, (symbol) => symbol.kind === "route")).toEqual([
      "/healthz", "GET /users/{id}", "POST /users",
    ]);
  });
});

describe("Rust extraction", () => {
  test("finds public items, inherent methods, modules, and macros", () => {
    const extraction = extract("src/lib.rs", `
//! pub fn doc_comment() {}
pub mod client;
mod internal;
pub mod inline {
    pub fn nested_in_module() {}
}

/// pub struct Commented;
pub struct Client<'a> { name: &'a str }
pub(crate) struct CrateOnly;
pub enum Mode { A, B }
pub trait Transport {}
pub type Result<T> = std::result::Result<T, Error>;
pub const MAX: usize = 10;
pub async fn connect() {}
fn private_helper() {}

impl<'a> Client<'a> {
    pub fn new(name: &'a str) -> Self { Self { name } }
    fn secret(&self) {}
}

impl Transport for Client<'_> {
    fn send(&self) {}
}

#[macro_export]
macro_rules! client_log { () => {}; }

const TEXT: &str = "pub fn fake() {}";
`);

    expect(exportedNames(extraction)).toEqual([
      "Client", "Client.new", "MAX", "Mode", "Result", "Transport", "client", "client_log", "connect", "inline",
    ]);
    expect(names(extraction)).not.toContain("doc_comment");
    expect(names(extraction)).not.toContain("Commented");
    expect(names(extraction)).not.toContain("fake");
    expect(names(extraction)).not.toContain("Client.send");
    expect(names(extraction)).not.toContain("nested_in_module");
    expect(extraction.symbols.find((symbol) => symbol.name === "CrateOnly")?.exported).toBe(false);
    expect(extraction.imports.filter((entry) => entry.kind === "module-declaration").map((entry) => entry.specifier))
      .toEqual(["client", "internal"]);
  });

  test("expands use trees and records pub use re-exports", () => {
    const extraction = extract("src/lib.rs", `
use std::collections::HashMap;
use crate::config::{self, Settings, loader::{load as load_config, Source}};
pub use crate::client::Client as HttpClient;
pub use crate::errors::*;
`);
    expect(specifiers(extraction)).toEqual([
      "crate::client::Client",
      "crate::config",
      "crate::config::Settings",
      "crate::config::loader::Source",
      "crate::config::loader::load",
      "crate::errors::*",
      "std::collections::HashMap",
    ]);
    expect(names(extraction, (symbol) => symbol.kind === "reexport")).toEqual(["HttpClient"]);
  });

  test("finds actix and axum routes", () => {
    const extraction = extract("src/routes.rs", `
#[get("/items/{id}")]
async fn item() {}
fn router() -> Router { Router::new().route("/health", get(health)) }
`);
    expect(names(extraction, (symbol) => symbol.kind === "route")).toEqual(["GET /items/{id}", "/health"]);
  });
});

describe("generic extraction", () => {
  test("finds declarations in other languages and skips comments", () => {
    const extraction = extract("src/main/java/com/acme/Billing.java", `
package com.acme;
import com.acme.store.Ledger;
// public class Commented {}
public final class Billing {
  private class Hidden {}
}
public interface Gateway {}
`);
    expect(exportedNames(extraction)).toEqual(["Billing", "Gateway"]);
    expect(extraction.symbols.find((symbol) => symbol.name === "Hidden")?.exported).toBe(false);
    expect(specifiers(extraction)).toEqual(["com.acme.store.Ledger"]);
  });

  test("uses hash comments for Ruby", () => {
    const extraction = extract("lib/acme.rb", "# class Commented\nclass Acme\n  def run\n  end\nend\n");
    expect(names(extraction)).toEqual(["Acme", "run"]);
  });
});

describe("language detection", () => {
  test("maps extensions and skips declaration files", () => {
    expect(detectLanguage("src/a.tsx")).toBe("typescript");
    expect(detectLanguage("src/a.mjs")).toBe("javascript");
    expect(detectLanguage("src/types.d.ts")).toBeNull();
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("Main.kt")).toBe("generic");
  });
});
