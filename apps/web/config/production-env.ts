/**
 * Vite loads `.env.local` in every mode, including production builds. A value
 * meant for local development must never reach the deployed bundle.
 */
const DEVELOPMENT_HOST_PATTERN =
  /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|dev\.doxa\.so)\b/i

/** Variables that must stay unset in a production bundle. */
const DEVELOPMENT_ONLY_KEYS = ["VITE_DEV_USER_ID"] as const

export function findUnsafeProductionEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("VITE_") || !value) continue
    if (DEVELOPMENT_ONLY_KEYS.some((devKey) => devKey === key)) {
      problems.push(`${key} is a development-only setting.`)
    } else if (DEVELOPMENT_HOST_PATTERN.test(value)) {
      problems.push(`${key} points to a development address (${value}).`)
    }
  }
  return problems
}

export function assertSafeProductionEnv(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const problems = findUnsafeProductionEnv(env)
  if (problems.length === 0) return
  throw new Error(
    [
      "Refusing to build production with local development settings:",
      ...problems.map((problem) => `- ${problem}`),
      "Set production values in the environment (see the deploy:web script in the root package.json).",
    ].join("\n"),
  )
}
