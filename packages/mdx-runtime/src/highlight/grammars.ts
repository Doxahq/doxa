/**
 * This module is the only owner of the Shiki grammar payloads.
 * Server-neutral modules must not import it.
 */
import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import graphql from "@shikijs/langs/graphql";
import html from "@shikijs/langs/html";
import http from "@shikijs/langs/http";
import java from "@shikijs/langs/java";
import javascriptReact from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import typescript from "@shikijs/langs/typescript";
import typescriptReact from "@shikijs/langs/tsx";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";

export const DOCS_THEMES = [githubLight, githubDark];

export const DOCS_LANGUAGES = [
  bash,
  json,
  typescript,
  typescriptReact,
  javascriptReact,
  css,
  markdown,
  yaml,
  python,
  go,
  html,
  sql,
  rust,
  java,
  diff,
  http,
  dockerfile,
  toml,
  graphql,
  xml,
  scss,
];
