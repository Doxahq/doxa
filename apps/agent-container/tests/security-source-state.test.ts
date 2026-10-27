import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { captureGenerationSourceState } from '../src/source-state';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

test('source-state capture never opens denied secret files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxa-security-state-'));
  try {
    await writeFile(join(root, '.env'), 'FAKE_SECRET=DOXA_CANARY_SOURCE_STATE');
    await writeFile(join(root, 'README.md'), '# Public client');
    vi.mocked(createReadStream).mockClear();
    await captureGenerationSourceState(root, { targetRevision: 'a'.repeat(40), sourceTreeHash: 'b'.repeat(40), changes: [] });
    const reads = vi.mocked(createReadStream).mock.calls.map(([path]) => basename(String(path)));
    expect(reads).toContain('README.md');
    expect(reads).not.toContain('.env');
  } finally {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
