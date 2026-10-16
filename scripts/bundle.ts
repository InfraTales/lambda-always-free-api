/**
 * Builds build/lambda/index.js: one file with every dependency inside, including the
 * AWS SDK clients, so the code we measure locally is the code we deploy.
 */
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

const root = path.join(__dirname, '..');
const outdir = path.join(root, 'build', 'lambda');

rmSync(outdir, { recursive: true, force: true });
const result = buildSync({
  entryPoints: [path.join(root, 'src', 'handler.ts')],
  outfile: path.join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
  metafile: true,
});

// Kept outside build/lambda so it isn't deployed. The bundle test reads it.
writeFileSync(path.join(root, 'build', 'meta.json'), JSON.stringify(result.metafile));

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`bundled ${path.relative(root, outdir)}/index.js (${(bytes / 1024).toFixed(0)} KiB with source map)`);
