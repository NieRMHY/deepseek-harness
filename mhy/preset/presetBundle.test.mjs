// Add by MHY, validate the bundle declaration and every referenced plugin against current schemas.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import { loadCordisYaml } from '../../scripts/cordis-yaml.ts';

test('declares the preset in a bundle and references current plugin names and Config fields', async t => {
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const patch = loadCordisYaml(await readFile(new URL(packageJson.dsh.bundle.patch, import.meta.url), 'utf8'));
  const declaration = patch[0].insert[0];
  assert.equal(declaration.name, '@deepseek-ai/dsh-agent-preset');
  const config = AgentPreset.Config(declaration.config);
  assert.equal(config.id, 'niermhy-standard');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  const checked = [];
  async function Check(entries) {
    for (const row of entries) {
      if (row.name === 'cordis:group') { await Check(row.config); continue; }
      const specifier = row.name.startsWith('.') ? new URL(row.name, import.meta.url).href : row.name;
      const plugin = ctx.loader.unwrapExports(await import(specifier));
      const schema = plugin.Config;
      if (schema) schema(row.config ?? {});
      checked.push(row.name);
    }
  }
  await Check(config.plugins);
  assert.ok(checked.includes('@deepseek-ai/dsh-workflow-ptc'));
  assert.ok(checked.includes('./router-bootstrap-v1.mjs'));
  assert.ok(checked.length > 20);
});
