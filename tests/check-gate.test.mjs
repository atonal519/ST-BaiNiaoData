import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSyntax } from '../scripts/check-syntax.mjs';
test('shared syntax gate covers valid, invalid and empty roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bainiao-check-gate-'));
  try {
    await writeFile(join(root, 'valid.mjs'), 'export const valid = true;\n');
    const valid = await checkSyntax(root, async () => ({ status: 0 })); assert.equal(valid, 1);
    await writeFile(join(root, 'invalid.mjs'), 'export const = broken;\n');
    await assert.rejects(checkSyntax(root, async (file) => ({ status: file.endsWith('invalid.mjs') ? 1 : 0 })), /语法检查失败/u);
    await rm(join(root, 'valid.mjs')); await rm(join(root, 'invalid.mjs'));
    await assert.rejects(checkSyntax(root, async () => ({ status: 0 })), /未发现/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
