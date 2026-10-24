/**
 * Part Prompt — Frontmatter Description
 * Constrains the frontmatter `description` field to max 20 words with a professional tone.
 */

import type { PartPrompt } from "./types";

export const descriptionPartPrompt: PartPrompt = {
  id: "description",
  target: "frontmatter.description",
  instructions: `## Frontmatter Description Guidelines
The frontmatter \`description\` field must be a concise phrase of at most 20 words.
Use one of these tones:
- Gerund phrase: "Understanding authentication flows in the API"
- Imperative verb: "Install and configure the CLI for your project"
- Noun phrase: "Configuration options for deployment pipelines"

Do NOT start with filler phrases like "Learn how to", "This page covers", "A guide to", "How to", "An overview of", "In this guide", or "This document explains".`,

  examples: [
    "Understanding authentication flows in the API",
    "Install and configure the CLI for your project",
    "Configuration options for deployment pipelines",
    "Core middleware concepts and request lifecycle",
    "Deploy applications to production with zero downtime",
  ],

  constraints: {
    maxWords: 20,
    minWords: 3,
  },

  antiPatterns: [
    /^learn how to\s+/i,
    /^this page covers\s+/i,
    /^a guide to\s+/i,
    /^how to\s+/i,
    /^an overview of\s+/i,
    /^in this guide,?\s+/i,
    /^this document explains\s+/i,
    /^this section covers\s+/i,
    /^this page explains\s+/i,
    /^this guide covers\s+/i,
    /^this page describes\s+/i,
    /^here you will learn\s+/i,
    /^this page provides\s+/i,
  ],
};
