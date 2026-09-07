import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import {
  inkFromRgba,
  inferLayout,
  detectPage,
  linkContinuations,
  numberAudit,
  edgeWarnings,
  uncoveredRegions,
} from '../lib/detect';
import { exportBook, layoutBook } from '../lib/export';
import { demoPdf } from '../lib/demo';
import { validateProject } from '../lib/project';
import type { Block, Span, Settings } from '../lib/model';

const require = createRequire(import.meta.url),
  pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { createCanvas } = createRequire(path.join(pdfRoot, 'package.json'))(
  '@napi-rs/canvas',
);
const filename = process.argv[2];
const bytes = filename
  ? new Uint8Array(await fs.readFile(filename))
  : await demoPdf();
const doc = await getDocument({
  data: bytes.slice(),
  standardFontDataUrl: pdfRoot + '/standard_fonts/',
  cMapUrl: pdfRoot + '/cmaps/',
  cMapPacked: true,
}).promise;
await fs.mkdir('test-output', { recursive: true });
const all: Block[] = [];
for (let page = 1; page <= doc.numPages; page++) {
  const p = await doc.getPage(page),
    vp = p.getViewport({ scale: 1 }),
    tc = await p.getTextContent();
  const spans: Span[] = tc.items.flatMap((i) => {
    if (!('str' in i) || !i.str.trim()) return [];
    const tx = Util.transform(vp.transform, i.transform),
      s = tc.styles[i.fontName],
      h = Math.hypot(tx[2], tx[3]);
    return [
      {
        text: i.str,
        x: tx[4],
        y: tx[5] - h * (s.ascent ?? 0.85),
        w: i.width,
        h,
        baseline: tx[5],
        font: i.fontName + ' ' + s.fontFamily,
      },
    ];
  });
  const v = p.getViewport({ scale: 2 }),
    canvas = createCanvas(Math.ceil(v.width), Math.ceil(v.height));
  await p.render({ canvas, viewport: v }).promise;
  const ctx = canvas.getContext('2d'),
    ink = inkFromRgba(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
      2,
    );
  const info = {
    page,
    width: vp.width,
    height: vp.height,
    spans,
    ...inferLayout(vp.width, vp.height, spans, ink),
  };
  const blocks = detectPage(info, ink);
  all.push(...blocks);
  console.log(
    'Page',
    page,
    'body',
    info.body,
    'columns',
    info.columns,
    'problems',
    blocks
      .filter((b) => b.kind === 'problem')
      .map((b) => b.label)
      .join(','),
  );
  console.log(
    'Warnings',
    blocks
      .filter((b) => b.warnings.some((w) => w.includes('잉크')))
      .map((b) => ({
        label: b.label,
        warning: b.warnings,
        rect: b.fragments[0].rect,
      })),
  );
  const before = canvas.toBuffer('image/png');
  await fs.writeFile(`test-output/source-${page}.png`, before);
  ctx.lineWidth = 1.5;
  ctx.font = '15px sans-serif';
  for (const b of blocks) {
    const r = b.fragments[0].rect;
    ctx.strokeStyle = b.kind === 'problem' ? '#165ce0' : '#c88300';
    ctx.strokeRect(r.x * 2, r.y * 2, r.w * 2, r.h * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(b.label, r.x * 2, r.y * 2 - 3);
  }
  await fs.writeFile(
    `test-output/detected-${page}.png`,
    canvas.toBuffer('image/png'),
  );
  await fs.writeFile(
    `test-output/blocks-${page}.json`,
    JSON.stringify({ info, blocks }, null, 2),
  );
  for (const b of blocks)
    for (const f of b.fragments)
      assert.equal(
        edgeWarnings(ink, f.rect).length,
        0,
        `Ink crossing: ${b.label}`,
      );
  assert.equal(
    uncoveredRegions(info, ink, blocks).length,
    0,
    'All in-body ink retained',
  );
  if (blocks.length > 1)
    assert.ok(
      uncoveredRegions(info, ink, blocks.slice(1)).length > 0,
      'Deleted block is found by coverage audit',
    );
  if (filename) {
    const q29 = blocks.find((b) => b.label === '29')!.fragments[0].rect;
    const lastLine = spans.find(
      (t) => t.x > 330 && t.y < 140 && t.text.includes('is a solution'),
    )!;
    assert.ok(
      lastLine && q29.y + q29.h > lastLine.baseline,
      '29 retains its prose after the piecewise equation',
    );
  }
}
const blocks = linkContinuations(all),
  audit = numberAudit(blocks);
if (filename) {
  assert.deepEqual(
    blocks.filter((b) => b.kind === 'problem').map((b) => +b.label),
    Array.from({ length: 35 }, (_, i) => 12 + i),
  );
  assert.deepEqual(audit, { missing: [], duplicates: [] });
} else {
  assert.equal(
    blocks.find((b) => b.label === '4')?.fragments.length,
    2,
    'Column continuation',
  );
  assert.equal(
    blocks.find((b) => b.label === '7')?.fragments.length,
    2,
    'Page continuation',
  );
}
const settings: Settings = {
  columns: 2,
  answerMm: 45,
  ruled: true,
  repeatInstructions: false,
  title: '',
};
const placements = layoutBook(blocks, settings);
assert.equal(
  placements.length,
  blocks.filter((b) => b.kind !== 'instruction' && b.selected).length,
);
for (const p of placements) {
  assert.ok(p.y + p.contentHeight + p.answerHeight <= 841.89 - 34 + 0.1);
}
const output = await exportBook(bytes, doc, blocks, settings);
await fs.writeFile('test-output/verified-workbook.pdf', output);
const result = await PDFDocument.load(output);
assert.ok(result.getPageCount() > 0);
console.log(
  'PASS: detection, no ink-crossing boundaries, continuation, atomic pagination; output pages:',
  result.getPageCount(),
);
const outputProxy = await getDocument({
  data: output.slice(),
  standardFontDataUrl: pdfRoot + '/standard_fonts/',
}).promise;
for (let i = 1; i <= Math.min(3, outputProxy.numPages); i++) {
  const p = await outputProxy.getPage(i),
    v = p.getViewport({ scale: 1.8 }),
    c = createCanvas(Math.ceil(v.width), Math.ceil(v.height));
  await p.render({ canvas: c, viewport: v }).promise;
  await fs.writeFile(`test-output/workbook-${i}.png`, c.toBuffer('image/png'));
}
assert.throws(() =>
  validateProject({ version: 1, fingerprint: 'bad' }, 'expected', 1),
);
await doc.destroy();
await outputProxy.destroy();
