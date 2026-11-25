export const SOCIAL_KINDS = ["x", "github", "linkedin", "discord", "youtube"] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];
export type SocialLinks = Partial<Record<SocialKind, string>>;

/** Where an image candidate lives. A repo file is read through the GitHub API, so private repos work. */
export type ImageLocation =
  | { kind: "repo"; path: string }
  | { kind: "url"; url: string }
  | { kind: "inline"; svg: string };

export type LogoSource =
  | "readme_picture"
  | "homepage_header"
  | "repo_file"
  | "json_ld"
  | "readme_image"
  | "context_dev";

export interface LogoCandidate {
  source: LogoSource;
  light: ImageLocation;
  dark: ImageLocation | null;
}

export interface FooterLink {
  label: string;
  href: string;
}

export interface FooterGroup {
  title: string;
  links: FooterLink[];
}
