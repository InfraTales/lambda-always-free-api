/**
 * Lambda loads index.js from the package root. Check that the bundle is one
 * self-contained file there, AWS SDK included, with nothing left to install.
 */
import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { BUNDLE_DIR } from '../../infra/lib/free-api-stack';

test('index.js sits at the package root, with only its source map beside it', () => {
  expect(fs.readdirSync(BUNDLE_DIR).sort()).toEqual(['index.js', 'index.js.map']);
});

test('the bundle imports nothing outside Node.js itself', () => {
  // esbuild's metafile lists every import it left unbundled. Only Node built-ins may remain.
  const meta = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, '..', 'meta.json'), 'utf8')) as {
    outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  };
  const builtins = new Set(builtinModules);
  const external = Object.values(meta.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path.replace(/^node:/, ''))
    .filter((p) => !builtins.has(p));
  expect([...new Set(external)]).toEqual([]);
});

test('the bundle loads in a fresh process and exports the handler', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `const m = require(${JSON.stringify(path.join(BUNDLE_DIR, 'index.js'))}); console.log(typeof m.handler)`], {
    env: { PATH: process.env.PATH },
  });
  expect(out.toString().trim()).toBe('function');
});
