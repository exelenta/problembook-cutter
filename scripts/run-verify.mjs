import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [path.join(root, 'scripts', 'verify.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: path.join(root, 'test-output', 'verify.mjs'),
});

const result = spawnSync(
  process.execPath,
  [path.join(root, 'test-output', 'verify.mjs'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
