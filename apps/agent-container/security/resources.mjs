export async function withCleanup(action, cleanup) {
  try {
    return await action();
  } finally {
    await cleanup();
  }
}

export async function cleanupOwned({ runId, containers, network }, docker) {
  const errors = [];
  const found = await docker(
    "ps",
    "-a",
    "--filter",
    `label=doxa.security.run=${runId}`,
    "--format",
    "{{.Names}}",
  ).catch(() => "");
  const names = [...new Set([...containers, ...found.split("\n").filter(Boolean)])];
  for (const name of names) {
    const owner = await docker(
      "inspect",
      "--format",
      '{{index .Config.Labels "doxa.security.run"}}',
      name,
    ).catch(() => "");
    if (owner.trim() !== runId) continue;
    await docker("rm", "-f", name).catch((error) => {
      errors.push({ resource: name, error: error.message });
    });
  }
  if (network) {
    const owner = await docker(
      "network",
      "inspect",
      "--format",
      '{{index .Labels "doxa.security.run"}}',
      network,
    ).catch(() => "");
    if (owner.trim() === runId)
      await docker("network", "rm", network).catch((error) => {
        errors.push({ resource: network, error: error.message });
      });
  }
  return errors;
}
