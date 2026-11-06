import { execFile } from 'node:child_process';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export class ServerPluginError extends Error {
  constructor(code, message, statusCode) { super(message); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, statusCode = 409) => new ServerPluginError(code, message, statusCode);
async function git(directory, ...args) {
  try {
    const { stdout } = await execute('git', args, {
      cwd: directory, timeout: 120000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('git_unavailable', '服务器未安装 Git，请先安装 Git 后再更新插件。', 500);
    throw error;
  }
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function packageData(directory) {
  try { const data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw fail('read_failed', '无法读取插件信息，请检查插件目录的读取权限。', 500);
  }
}
async function dependencies(directory, data) {
  const declared = Object.keys(data.dependencies ?? {}).filter(name => !Object.hasOwn(data.optionalDependencies ?? {}, name)).sort();
  const missing = [];
  for (const name of declared) {
    // Node may resolve packages from the plugin itself or a parent node_modules.
    let location = directory, installed = false;
    while (true) {
      if (await exists(join(location, 'node_modules', name, 'package.json'))) { installed = true; break; }
      const parent = dirname(location); if (parent === location) break; location = parent;
    }
    if (!installed) missing.push(name);
  }
  return { hasDependencies: declared.length > 0, declared, missing, needsInstall: missing.length > 0 };
}
async function ownRepository(directory) {
  let top;
  try { top = await git(directory, 'rev-parse', '--show-toplevel'); }
  catch (error) { if (error instanceof ServerPluginError) throw error; return false; }
  // A ZIP directory can be inside the host's repository; that is not its own repository.
  return await realpath(top) === await realpath(directory);
}
async function tracking(directory) {
  try {
    const branch = await git(directory, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    const remote = await git(directory, 'config', '--get', `branch.${branch}.remote`);
    const merge = await git(directory, 'config', '--get', `branch.${branch}.merge`);
    const url = remote === '.' ? '.' : await git(directory, 'config', '--get', `remote.${remote}.url`);
    if (remote && merge.startsWith('refs/heads/') && url) return { remote, merge, url };
  } catch (error) { if (error instanceof ServerPluginError) throw error; }
  return null;
}
function publicRemote(value) {
  if (value === '.') return '';
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return /^[^/@\s]+@[^:\s]+:/.test(value) ? value.replace(/^[^@]+@/, '') : ''; }
}
async function metadata(directory, name, repository, upstream) {
  const data = await packageData(directory);
  return {
    directory: name, packageName: String(data.name ?? ''), name: String(data.name ?? name),
    version: String(data.version ?? ''), description: String(data.description ?? ''),
    canUpdate: repository && Boolean(upstream), remoteUrl: upstream ? publicRemote(upstream.url) : '',
    dependencyStatus: await dependencies(directory, data),
  };
}

/** Lists metadata only; only an explicit update may fetch the selected repository. */
export function createServerPluginService({ pluginsPath }) {
  const root = resolve(pluginsPath);
  async function list() {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw fail('list_failed', '读取服务端插件列表失败，请检查插件目录的读取权限。', 500); }
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const path = join(root, entry.name);
        let repository;
        try { repository = await ownRepository(path); }
        catch (error) { if (error.code !== 'git_unavailable') throw error; repository = false; }
        result.push(await metadata(path, entry.name, repository, repository ? await tracking(path) : null));
      } else if (entry.isFile() && /\.(?:js|cjs|mjs)$/i.test(entry.name)) {
        result.push({ directory: entry.name, packageName: '', name: entry.name, version: '', description: '', canUpdate: false });
      }
    }
    return result;
  }
  async function update(directory) {
    if (typeof directory !== 'string' || !directory || directory.startsWith('.')
        || directory.includes('/') || directory.includes('\\') || directory.includes('\0') || basename(directory) !== directory) {
      throw fail('invalid_directory', '请选择插件列表中的一个插件目录。', 400);
    }
    const path = join(root, directory);
    let entry;
    try { entry = await lstat(path); }
    catch (error) {
      if (error.code === 'ENOENT') throw fail('not_found', '该插件目录已不存在，请重新检查连接以读取插件列表。', 404);
      throw fail('read_failed', '无法读取插件目录，请检查服务器目录权限。', 500);
    }
    if (!entry.isDirectory() || !await ownRepository(path)) throw fail('not_git', '此插件不是独立 Git 仓库，请按原安装方式更新。');
    const upstream = await tracking(path);
    if (!upstream) throw fail('no_upstream', '此插件未配置远程上游，请在服务器配置上游分支后再更新。');
    const changes = await git(path, 'status', '--porcelain', '--untracked-files=normal');
    if (changes) throw fail('local_changes', '此插件有本地修改，请先在服务器保存或处理这些修改，再更新。');
    const previous = await git(path, 'rev-parse', 'HEAD');
    try { await git(path, 'pull', '--ff-only', '--', upstream.remote, upstream.merge); }
    catch (error) {
      if (error instanceof ServerPluginError) throw error;
      if (/fast-forward|divergent|diverged/i.test(error.stderr ?? '')) throw fail('branch_conflict', '插件分支无法直接更新，请在服务器处理分支差异后重试。');
      throw fail('pull_failed', '拉取插件更新失败，请检查服务器网络和 Git 访问权限后重试。', 500);
    }
    const current = await git(path, 'rev-parse', 'HEAD');
    const changed = previous !== current;
    const plugin = { ...await metadata(path, directory, true, upstream), currentCommitHash: current, isUpToDate: !changed };
    return { plugin, restartRecommended: changed };
  }
  return { list, update };
}
