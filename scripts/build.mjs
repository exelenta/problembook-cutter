import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const windowsUvShutdownRace =
  process.platform === 'win32' &&
  [3221226505, -1073740791].includes(result.status) &&
  existsSync(path.resolve('dist/client/index.html'));
if (windowsUvShutdownRace) {
  console.warn(
    'Build artifacts are complete; ignored the known Windows libuv shutdown race.',
  );
  process.exit(0);
}
process.exit(result.status ?? 1);
