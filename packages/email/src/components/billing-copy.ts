/** Shared words of the billing emails (billing spec 10.7). */

/** The subject of a sentence: "Your account" or "The Acme team". */
export function accountSubject(teamName: string | undefined): string {
  return teamName ? `The ${teamName} team` : "Your account";
}

/** The footer line that says why this person got the email. */
export function billingReason(teamName: string | undefined): string {
  return teamName
    ? `You got this email because you manage billing for the ${teamName} team.`
    : "You got this email because you own this Doxa account.";
}

/** Decision D19: no Pay now. Doxa charges the card automatically. */
export function automaticChargeNote(chargeAtUsd: string): string {
  return `Doxa charges your card automatically when your balance reaches ${chargeAtUsd}, and once a month.`;
}
