// Add by MHY, behavior checks for resolved dependency versions and native sibling lookup.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const assembler = fileURLToPath(new URL('./assembleRuntime.mjs', import.meta.url));
async function Package(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs', ...manifest }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), text);
  }
}
function Run(args) {
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.signal, null);
  return child;
}

test('preserves each owner version and native-library sibling resolution', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-layout-'));
  t.after(() => rm(temporary, { recursive: true }));
  const source = join(temporary, 'source');
  const output = join(temporary, 'runtime');
  const cli = join(source, 'apps/cli');
  await Package(cli, { name: 'test-cli', version: '1.0.0', main: 'index.js', dependencies: { a: '1', b: '1', '@img/native': '1' }, optionalDependencies: { 'other-platform': '1' } }, {
    'index.js': "console.log(JSON.stringify([require('a'),require('b'),require('@img/native')]))",
    'src/private.txt': 'workspace source', '.git/private.txt': 'git metadata',
  });
  for (const [name, version] of [['a', '1.0.0'], ['b', '2.0.0']]) {
    const owner = join(source, 'node_modules', name);
    await Package(owner, { name, version: '1.0.0', main: 'index.js', dependencies: { versioned: version } }, { 'index.js': "module.exports=require('versioned')" });
    await Package(join(owner, 'node_modules/versioned'), { name: 'versioned', version, main: 'index.js' }, { 'index.js': 'module.exports=' + JSON.stringify(version) });
  }
  await Package(join(source, 'node_modules/@img/native'), { name: '@img/native', version: '1.0.0', main: 'lib/index.js', optionalDependencies: { '@img/vips': '1' } }, {
    'lib/index.js': "module.exports=require('fs').readFileSync(require('path').join(__dirname,'../../vips/lib/value.txt'),'utf8')",
  });
  await Package(join(source, 'node_modules/@img/vips'), { name: '@img/vips', version: '1.0.0' }, { 'lib/value.txt': 'native-sibling' });
  const assembled = Run([assembler, '--source', source, '--output', output]);
  assert.equal(assembled.status, 0, assembled.stderr);
  const executed = Run([join(output, 'index.js')]);
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual(JSON.parse(executed.stdout), ['1.0.0', '2.0.0', 'native-sibling']);
  await assert.rejects(readFile(join(output, 'src/private.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(output, '.git/private.txt')), { code: 'ENOENT' });
  const repeated = Run([assembler, '--source', source, '--output', output]);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /already exists/);
  assert.deepEqual(JSON.parse(Run([join(output, 'index.js')]).stdout), ['1.0.0', '2.0.0', 'native-sibling']);
});

test('rejects missing required dependencies before creating output', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-runtime-missing-'));
  t.after(() => rm(temporary, { recursive: true }));
  const source = join(temporary, 'source');
  const output = join(temporary, 'runtime');
  await Package(join(source, 'apps/cli'), { name: 'missing-cli', version: '1.0.0', dependencies: { 'not-installed': '1' } });
  const child = Run([assembler, '--source', source, '--output', output]);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Missing dependency: missing-cli -> not-installed/);
  await assert.rejects(readFile(join(output, 'package.json')), { code: 'ENOENT' });
});
