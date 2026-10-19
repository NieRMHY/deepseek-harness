// Add by MHY, offline CLI assembly preserving resolved versions and native sibling libraries.
import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
  output: { type: 'string' },
  profile: { type: 'string' },
} });
if (!values.output) throw new Error('Usage: node mhy/assembleRuntime.mjs --output <new-directory> [--source <checkout>] [--profile <profile-directory>]');
const source = await realpath(values.source);
const output = resolve(values.output);
const sourceRelative = relative(source, output);
if (sourceRelative === '' || (!sourceRelative.startsWith('..' + sep) && sourceRelative !== '..' && !isAbsolute(sourceRelative))) {
  throw new Error('Output must be outside the source checkout');
}
try { await lstat(output); throw new Error('Output already exists: ' + output); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const nodes = new Map();

async function ResolvePackage(name, owner) {
  const require = createRequire(join(owner, 'package.json'));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    try { await lstat(join(candidate, 'package.json')); return await realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  return null;
}

async function Visit(directory) {
  directory = await realpath(directory);
  if (nodes.has(directory)) return nodes.get(directory);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const id = manifest.name.replaceAll('/', '+').replaceAll('@', '') + '-' + manifest.version + '-' + createHash('sha256').update(directory).digest('hex').slice(0, 10);
  const node = { directory, manifest, id, dependencies: new Map() };
  nodes.set(directory, node);
  for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (name === manifest.name) continue;
    const found = await ResolvePackage(name, directory);
    if (found) node.dependencies.set(name, await Visit(found));
    else if (!manifest.optionalDependencies?.[name] && !manifest.peerDependenciesMeta?.[name]?.optional) {
      throw new Error('Missing dependency: ' + manifest.name + ' -> ' + name);
    }
  }
  return node;
}

const cli = await Visit(join(source, 'apps/cli'));
if (values.profile) {
  // Existing parent-profile links need these packages even when the new CLI does not import them.
  const compatibilityPackages = ['typescript', 'dequal', '@aws-crypto/util', '@aws-crypto/sha256-js', '@aws-crypto/sha256-browser', '@aws-crypto/supports-web-crypto', '@aws-sdk/util-locate-window', '@opentelemetry/exporter-logs-otlp-http', '@smithy/util-buffer-from', '@smithy/util-utf8', '@smithy/is-array-buffer'];
  const profile = await realpath(values.profile);
  for (const name of compatibilityPackages) {
    const directory = await ResolvePackage(name, profile);
    if (!directory) throw new Error('Missing profile compatibility package: ' + name);
    await Visit(directory);
  }
}
await mkdir(output, { recursive: true });
for (const node of nodes.values()) {
  const container = node === cli ? output : join(output, 'node_modules/.closure', node.id);
  node.destination = node === cli ? output : join(container, 'node_modules', node.manifest.name);
  node.dependencyRoot = join(container, 'node_modules');
  await mkdir(dirname(node.destination), { recursive: true });
  await cp(node.directory, node.destination, { recursive: true, dereference: true, filter: filename => {
    const first = relative(node.directory, filename).split(sep)[0];
    const workspacePackage = node.directory.startsWith(source + sep) && !node.directory.includes(sep + 'node_modules' + sep);
    return !['node_modules', '.git'].includes(first) && !(workspacePackage && ['src', 'tests'].includes(first));
  } });
}
for (const node of nodes.values()) {
  // ELF $ORIGIN searches sibling scoped packages, so dependencies share the container node_modules.
  for (const [name, dependency] of node.dependencies) {
    const link = join(node.dependencyRoot, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), dependency.destination), link);
  }
}
const promoted = new Map(cli.dependencies);
for (const node of nodes.values()) if (node !== cli && !promoted.has(node.manifest.name)) promoted.set(node.manifest.name, node);
for (const [name, node] of promoted) {
  const link = join(output, 'node_modules', name);
  try { await lstat(link); continue; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(link), { recursive: true });
  await symlink(relative(dirname(link), node.destination), link);
}
const report = { version: cli.manifest.version, packages: nodes.size, packagesByName: [...nodes.values()].map(node => ({ name: node.manifest.name, version: node.manifest.version })) };
await writeFile(join(output, 'assembly-manifest.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10));
console.log(JSON.stringify({ output, version: report.version, packages: report.packages }));
