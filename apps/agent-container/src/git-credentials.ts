import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$DOXA_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
`;

export interface GitCredentialSession {
  readonly environment: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export type GitCredentialSessionFactory = (
  token: string,
) => Promise<GitCredentialSession>;

export async function createGitCredentialSession(
  token: string,
): Promise<GitCredentialSession> {
  const directoryPath = await mkdtemp(join(tmpdir(), "doxa-git-credentials-"));
  const askpassPath = join(directoryPath, "askpass.sh");

  try {
    await chmod(directoryPath, 0o700);
    await writeFile(askpassPath, ASKPASS_SCRIPT, { encoding: "utf8", mode: 0o700 });
    await chmod(askpassPath, 0o700);
  } catch (error) {
    await rm(directoryPath, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") {
      delete environment[key];
    }
  }
  Object.assign(environment, {
    DOXA_GIT_TOKEN: token,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  });

  return {
    environment,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(directoryPath, { recursive: true, force: true });
    },
  };
}
