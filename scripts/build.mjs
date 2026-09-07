import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const pkg = path.resolve('node_modules/vinext/package.json');
const { bin } = JSON.parse(readFileSync(pkg, 'utf8'));
// Avoid a Windows Node/libuv shutdown race after Vite's multi-environment build.
const result = spawnSync(
  process.execPath,
  [
    path.resolve(path.dirname(pkg), typeof bin === 'string' ? bin : bin.vinext),
    'build',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '1',
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
