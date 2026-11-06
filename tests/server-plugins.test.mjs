import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerPluginService } from '../src/server-plugins.mjs';

const execute = promisify(execFile);
const fixtureEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
async function git(cwd, ...args) {
  const { stdout } = await execute('git', [
    '-c', 'user.name=Local Plugin Fixture',
    '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always',
    ...args,
  ], { cwd, env: fixtureEnvironment });
  return stdout.trim();
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'bainiao-server-plugins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function packageFile(directory, version, name = 'fixture-plugin') {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name, version, description: 'Local installed plugin fixture',
  }));
}
async function commitPackage(directory, version) {
  await packageFile(directory, version);
  await git(directory, 'add', 'package.json');
  await git(directory, 'commit', '-m', 'Package ' + version);
}
async function remoteFixture(root, name) {
  const remote = join(root, name + '.git');
  const seed = join(root, name + '-seed');
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'init', '--initial-branch=main', seed);
  await commitPackage(seed, '1.0.0');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', '-u', 'origin', 'main');
  return { remote, seed };
}
const findEntry = (entries, name) => entries.find(entry =>
  [entry.directory, entry.file, entry.name, entry.packageName].includes(name));

test('list reads installed metadata and file plugins without executing their modules', async t => {
  const root = await temporary(t);
  const pluginsPath = join(root, 'plugins');
  await packageFile(join(pluginsPath, 'metadata-plugin'), '1.2.3', 'example-metadata');
  await writeFile(join(pluginsPath, 'metadata-plugin', 'index.mjs'),
    "throw new Error('Installed plugin code must not run during list');");
  await mkdir(join(pluginsPath, 'unpackaged-plugin'));
  for (const name of ['legacy.js', 'legacy.cjs', 'legacy.mjs']) {
    await writeFile(join(pluginsPath, name),
      "throw new Error('Top-level plugin code must not run during list');");
  }
  for(const [name,value] of [['null-package',null],['array-package',[]],['scalar-package','old-fixture']]){const directory=join(pluginsPath,name);await mkdir(directory);await writeFile(join(directory,'package.json'),JSON.stringify(value));await writeFile(join(directory,'index.mjs'),"throw new Error('Do not execute metadata plugins');");}
  const service = await createServerPluginService({ pluginsPath });
  const entries = await service.list();
  const metadata = findEntry(entries, 'metadata-plugin');
  assert.ok(metadata, 'package directories remain visible');
  assert.equal(metadata.packageName ?? metadata.id, 'example-metadata');
  assert.equal(metadata.version, '1.2.3');
  assert.equal(metadata.description, 'Local installed plugin fixture');
  assert.equal(metadata.canUpdate, false, 'a plain directory is not a Git update target');
  assert.ok(findEntry(entries, 'unpackaged-plugin'), 'missing package.json does not hide an installed directory');
  for(const name of ['null-package','array-package','scalar-package']){const entry=findEntry(entries,name);assert.ok(entry);assert.equal(entry.version,'');assert.equal(entry.canUpdate,false);}
  for (const name of ['legacy.js', 'legacy.cjs', 'legacy.mjs']) {
    const entry = findEntry(entries, name);
    assert.ok(entry, name + ' remains visible');
    assert.equal(entry.canUpdate, false, 'file plugins do not offer directory updates');
  }
  assert.equal(JSON.stringify(entries).includes(pluginsPath), false, 'installed metadata does not expose absolute disk paths');
});

test('a ZIP plugin inside the host repository cannot inherit or update the host Git remote', async t => {
  const root = await temporary(t);
  const { remote, seed } = await remoteFixture(root, 'host');
  const host = join(root, 'host-checkout');
  await git(root, 'clone', remote, host);
  const pluginsPath = join(host, 'plugins');
  await packageFile(join(pluginsPath, 'zip-plugin'), '1.0.0', 'zip-plugin');
  await git(host, 'add', 'plugins');
  await git(host, 'commit', '-m', 'Install plain ZIP plugin');
  await git(host, 'push');
  await git(seed, 'pull', '--ff-only');
  await commitPackage(seed, '2.0.0');
  await git(seed, 'push');
  const before = await git(host, 'rev-parse', 'HEAD');
  const service = await createServerPluginService({ pluginsPath });
  const entry = findEntry(await service.list(), 'zip-plugin');
  assert.ok(entry);
  assert.equal(entry.canUpdate, false);
  await assert.rejects(() => service.update('zip-plugin'), error =>
    /Git|git|仓库/.test(error.message));
  assert.equal(await git(host, 'rev-parse', 'HEAD'), before, 'the host checkout stays at its original commit');
  assert.equal(JSON.parse(await readFile(join(host, 'package.json'), 'utf8')).version, '1.0.0');
});

test('one selected plugin pulls its local remote and rereads disk version while another remains unchanged', async t => {
  const root = await temporary(t);
  const { remote, seed } = await remoteFixture(root, 'plugins');
  const pluginsPath = join(root, 'installed');
  await mkdir(pluginsPath);
  const alpha = join(pluginsPath, 'alpha');
  const beta = join(pluginsPath, 'beta');
  await git(root, 'clone', remote, alpha);
  await git(root, 'clone', remote, beta);
  await git(alpha, 'remote', 'rename', 'origin', 'configured-upstream');
  const betaBefore = await git(beta, 'rev-parse', 'HEAD');
  await commitPackage(seed, '2.0.0');
  await git(seed, 'push');
  const service = await createServerPluginService({ pluginsPath });
  const before = await service.list();
  assert.equal(findEntry(before, 'alpha').canUpdate, true);
  assert.equal(findEntry(before, 'alpha').version, '1.0.0', 'listing does not fetch or install remote content');
  const result = await service.update('alpha');
  assert.equal(result.plugin.directory, 'alpha');
  assert.equal(result.plugin.version, '2.0.0');
  assert.equal(result.plugin.isUpToDate, false);
  assert.equal(result.restartRecommended, true);
  assert.equal(JSON.parse(await readFile(join(alpha, 'package.json'), 'utf8')).version, '2.0.0');
  assert.equal(await git(beta, 'rev-parse', 'HEAD'), betaBefore);
  assert.equal(JSON.parse(await readFile(join(beta, 'package.json'), 'utf8')).version, '1.0.0');
  const unchanged = await service.update('alpha');
  assert.equal(unchanged.plugin.isUpToDate, true);
  assert.equal(unchanged.restartRecommended, false);
  assert.equal(unchanged.plugin.version, '2.0.0');
});

test('normal repositories without an upstream remain listed and explain why they cannot update', async t => {
  const root = await temporary(t);
  const pluginsPath = join(root, 'plugins');
  const directory = join(pluginsPath, 'local-plugin');
  await mkdir(directory, { recursive: true });
  await git(directory, 'init', '--initial-branch=main');
  await commitPackage(directory, '1.0.0');
  const service = await createServerPluginService({ pluginsPath });
  const entry = findEntry(await service.list(), 'local-plugin');
  assert.ok(entry);
  assert.equal(entry.canUpdate, false);
  await assert.rejects(() => service.update('local-plugin'), error =>
    /上游|远程|remote|upstream/.test(error.message));
});

test('without Git the service still lists metadata and reports Git unavailable only on update', async t => {
  const root = await temporary(t);
  const pluginsPath = join(root, 'plugins');
  await packageFile(join(pluginsPath, 'plain-plugin'), '1.2.3');
  const emptyPath = join(root, 'empty-path');
  await mkdir(emptyPath);
  const resultPath = join(root, 'git-unavailable-result.json');
  const moduleUrl = new URL('../src/server-plugins.mjs', import.meta.url).href;
  const script = [
    'import { createServerPluginService } from ' + JSON.stringify(moduleUrl) + ';',
    "import { writeFile } from 'node:fs/promises';",
    'const service = createServerPluginService({pluginsPath:process.argv[1]});',
    'const entries = await service.list();',
    'let failure;',
    "try { await service.update('plain-plugin'); } catch(error) { failure = {code:error.code,message:error.message}; }",
    'await writeFile(process.argv[2],JSON.stringify({entries,failure}));',
  ].join('\n');
  await execute(process.execPath, ['--input-type=module', '-e', script, pluginsPath, resultPath], {
    env: { ...fixtureEnvironment, PATH: emptyPath },
  });
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.entries[0].directory, 'plain-plugin');
  assert.equal(result.entries[0].version, '1.2.3');
  assert.equal(result.entries[0].canUpdate, false);
  assert.equal(result.failure.code, 'git_unavailable');
  assert.match(result.failure.message, /Git/);
});

test('missing required dependencies need installation while missing optional dependencies do not', async t => {
  const root = await temporary(t);
  const pluginsPath = join(root, 'plugins');
  const directory = join(pluginsPath, 'dependency-plugin');
  await packageFile(directory, '1.0.0');
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'fixture-dependencies', version: '1.0.0',
    dependencies: { 'required-fixture-package': '1.0.0' },
    optionalDependencies: { 'optional-fixture-package': '1.0.0' },
  }));
  const service = await createServerPluginService({ pluginsPath });
  const missing = findEntry(await service.list(), 'dependency-plugin').dependencyStatus;
  assert.equal(missing.needsInstall, true);
  assert.ok(missing.missing.includes('required-fixture-package'));
  assert.equal(missing.missing.includes('optional-fixture-package'), false);
  await packageFile(join(directory, 'node_modules', 'required-fixture-package'), '1.0.0', 'required-fixture-package');
  const installed = findEntry(await service.list(), 'dependency-plugin').dependencyStatus;
  assert.equal(installed.needsInstall, false);
  assert.deepEqual(installed.missing, []);
});

test('update rejects path traversal, symlink targets and dirty plugins without changing any HEAD',async t=>{
 const root=await temporary(t),{remote}=await remoteFixture(root,'guard-remote'),pluginsPath=join(root,'plugins');await mkdir(pluginsPath);
 const alpha=join(pluginsPath,'alpha'),outside=join(root,'outside');await git(root,'clone',remote,alpha);await git(root,'clone',remote,outside);await symlink(outside,join(pluginsPath,'linked'),'junction');
 const service=createServerPluginService({pluginsPath}),head=await git(alpha,'rev-parse','HEAD'),outsideHead=await git(outside,'rev-parse','HEAD');
 for(const directory of ['',null,[],{},'.','..','../outside','alpha/sub','alpha\\sub','alpha\0bad'])await assert.rejects(service.update(directory),error=>error.code==='invalid_directory');
 assert.equal(findEntry(await service.list(),'linked'),undefined);await assert.rejects(service.update('linked'),error=>error.code==='not_git');
 await writeFile(join(alpha,'untracked.txt'),'local');await assert.rejects(service.update('alpha'),error=>error.code==='local_changes');await rm(join(alpha,'untracked.txt'));await packageFile(alpha,'local-edit');await assert.rejects(service.update('alpha'),error=>error.code==='local_changes');
 assert.equal(await git(alpha,'rev-parse','HEAD'),head);assert.equal(await git(outside,'rev-parse','HEAD'),outsideHead);assert.equal(JSON.parse(await readFile(join(alpha,'package.json'),'utf8')).version,'local-edit');
});

test('metadata strips remote credentials without fetching and detached repositories cannot update',async t=>{
 const root=await temporary(t),pluginsPath=join(root,'plugins'),directory=join(pluginsPath,'alpha');await mkdir(directory,{recursive:true});await git(directory,'init','--initial-branch=main');await commitPackage(directory,'1.0.0');
 await git(directory,'remote','add','origin','https://user:secret@example.invalid/project.git?token=private#hidden');await git(directory,'config','branch.main.remote','origin');await git(directory,'config','branch.main.merge','refs/heads/main');
 const service=createServerPluginService({pluginsPath}),entry=findEntry(await service.list(),'alpha');assert.equal(entry.remoteUrl,'https://example.invalid/project.git');assert.equal(entry.canUpdate,true);assert.doesNotMatch(JSON.stringify(entry),/secret|private|hidden|user:/);
 await git(directory,'checkout','--detach');assert.equal(findEntry(await service.list(),'alpha').canUpdate,false);await assert.rejects(service.update('alpha'),error=>error.code==='no_upstream');
});
