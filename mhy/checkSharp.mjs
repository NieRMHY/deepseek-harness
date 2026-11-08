// Add by MHY, verify the assembled runtime in a clean process with real image operations.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node mhy/checkSharp.mjs <runtime-directory>');
const runtime = await realpath(resolve(process.argv[2]));
if (process.argv[3] !== '--child') {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-sharp-check-'));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), runtime, '--child'], {
      cwd: temporary, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: temporary }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.signal, null, 'Sharp check was interrupted');
    assert.equal(child.status, 0, child.stderr);
    process.stdout.write(child.stdout);
  } finally { await rm(temporary, { recursive: true }); }
} else {
  const require = createRequire(join(runtime, 'package.json'));
  const sharp = require('sharp');
  const source = Buffer.from('<svg width="24" height="16"><rect width="24" height="16" fill="red"/><rect x="12" width="12" height="16" fill="blue"/></svg>');
  const images = [];
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await sharp(source).toFormat(format).toBuffer();
    const original = await sharp(bytes).metadata();
    assert.equal(original.format, format);
    assert.equal(original.width, 24);
    assert.equal(original.height, 16);
    const resized = await sharp(bytes).resize(12, 8).raw().toBuffer({ resolveWithObject: true });
    assert.equal(resized.info.width, 12);
    assert.equal(resized.info.height, 8);
    assert.ok(resized.data[0] > resized.data[2] + 100, 'Left pixel must remain predominantly red');
    images.push({ format, bytes: bytes.length, width: resized.info.width, height: resized.info.height });
  }
  const libraries = process.report.getReport().sharedObjects.filter(filename => /libvips/.test(filename));
  assert.ok(libraries.length, 'libvips was not loaded');
  for (const filename of libraries) {
    const location = relative(runtime, await realpath(filename));
    assert.ok(location !== '..' && !location.startsWith('..' + sep), 'libvips must come from the assembled runtime');
  }
  console.log(JSON.stringify({ passed: true, sharp: sharp.versions.sharp, vips: sharp.versions.vips, images }));
}
