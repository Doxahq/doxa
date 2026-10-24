import { z } from "zod";
import { defineEmailKind, type EmailKindProps } from "./define-email-kind";
import { displayName, emailLink } from "./fields";

export const TEAM_INVITE_ROLES = ["owner", "admin", "editor", "viewer"] as const;

export const teamInviteEmail = defineEmailKind({
  name: "team-invite",
  category: "transactional",
  props: z.object({
    inviterName: displayName,
    teamName: displayName,
    role: z.enum(TEAM_INVITE_ROLES),
    acceptUrl: emailLink,
    expiresInDays: z.number().int().positive(),
  }),
});

export type TeamInviteEmailProps = EmailKindProps<typeof teamInviteEmail>;
export type TeamInviteRole = TeamInviteEmailProps["role"];
