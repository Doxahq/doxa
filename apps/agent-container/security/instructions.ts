import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_DOXABOT_INSTRUCTIONS, saveDoxabotInstructionsInputSchema } from "@doxahq/contracts";
import { DoxabotInstructionsService } from "../../api/src/services/doxabot/instructions";
import { loadGenerationInstructions } from "../../api/src/services/doxabot/generation-instructions";
import { toInstructionsFile } from "../../api/src/services/doxabot/repository-instructions-file";
import { InMemoryProjectInstructionsStore } from "../../api/tests/support/in-memory-project-instructions";

const [inputPath, outputPath] = process.argv.slice(2);
const cases = JSON.parse(await readFile(inputPath!, "utf8")) as Array<{
  id: string;
  text?: string;
  channel: string;
}>;
const output: Record<string, unknown> = {};
for (const entry of cases) {
  const store = new InMemoryProjectInstructionsStore();
  const service = new DoxabotInstructionsService(store);
  const parsed = saveDoxabotInstructionsInputSchema.parse({
    baseVersion: null,
    instructions: {
      ...DEFAULT_DOXABOT_INSTRUCTIONS,
      context: entry.channel === "editor" ? (entry.text ?? "") : "",
      repositoryFile: { enabled: entry.channel === "repository" },
    },
  });
  await service.save({ projectId: entry.id, actorUserId: "local-audit-owner", ...parsed });
  output[entry.id] = await loadGenerationInstructions(
    {
      getCurrent: (id) => service.getCurrent(id),
      readRepositoryFile: async () => toInstructionsFile(new TextEncoder().encode(entry.text ?? "")),
    },
    entry.id,
  );
}
await writeFile(outputPath!, JSON.stringify(output, null, 2));
