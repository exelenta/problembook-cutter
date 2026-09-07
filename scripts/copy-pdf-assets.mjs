import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await fs.mkdir('public/pdf-assets', { recursive: true });
  await fs.cp(path.join(root, dir), path.join('public/pdf-assets', dir), {
    recursive: true,
  });
}
