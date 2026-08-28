import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ignored = new Set(['node_modules', '.git']);
export async function findMjs(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { throw new Error(`无法读取检查目录：${directory}`); }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) await visit(join(directory, entry.name)); }
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(join(directory, entry.name));
    }
  }
  await visit(root); return files.sort();
}
const nodeCheck = (file) => spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
export async function checkSyntax(root, checkFile = nodeCheck) {
  const files = await findMjs(root); if (files.length === 0) throw new Error('未发现可检查的 .mjs 文件');
  for (const file of files) { const result = await checkFile(file); if (result?.error || result?.status !== 0) throw new Error(`语法检查失败：${relative(root, file)}`); }
  return files.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(`语法检查通过：${await checkSyntax(process.argv[2] ?? process.cwd())} 个 .mjs`); } catch (error) { console.error(error instanceof Error ? error.message : '语法检查失败'); process.exitCode = 1; }
}
