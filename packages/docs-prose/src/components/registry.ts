import type { ProseComponentMap } from "../render/runtime-mdx-content";
import {
  createCard,
  CardGrid,
  type IconComponent,
  type IconResolver,
} from "./card";
import { Embed } from "./embed";
import { createFileTree, type FileTreeIcons } from "./file-tree";
import { ProseLink, type ProseLinkComponent } from "./link";
import { Note } from "./note";
import { Step, StepItem } from "./step";

export interface CreateProseComponentsOptions {
  /** Link used inside prose. Defaults to a plain anchor. */
  link?: ProseLinkComponent;
  /** Resolves a card's `icon` name. Defaults to no icon. */
  resolveIcon?: IconResolver;
  /** Corner marker drawn on an external card. */
  externalIcon?: IconComponent;
  /** Icons for `<FileTree>`. Without them the file tree is left unregistered. */
  fileTreeIcons?: FileTreeIcons;
  /**
   * Components the host supplies instead of the shared ones: an interactive
   * tab set, a syntax-highlighted code block, an API reference block.
   */
  overrides?: Partial<ProseComponentMap>;
}

/**
 * Builds the prose component map.
 *
 * The shared entries are the ones whose appearance defines a documentation
 * page: notes, cards, steps, and video embeds. Anything a host renders
 * differently — an interactive component, a highlighter, an API block —
 * arrives through `overrides`, so a host extends the map without editing
 * this package.
 */
export function createProseComponents({
  link = ProseLink,
  resolveIcon = () => null,
  externalIcon,
  fileTreeIcons,
  overrides = {},
}: CreateProseComponentsOptions = {}): ProseComponentMap {
  return {
    a: link,
    Card: createCard({ link, resolveIcon, ExternalIcon: externalIcon }),
    CardGrid,
    Embed,
    Note,
    Step,
    StepItem,
    ...(fileTreeIcons ? createFileTree(fileTreeIcons) : {}),
    ...overrides,
  };
}
