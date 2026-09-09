import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  detectPage,
  inferLayout,
  inkFromRgba,
  linkContinuations,
  numberAudit,
} from '../lib/detect';
import { parsePageRanges } from '../lib/section-ranges';
import type { Span } from '../lib/model';

const filename = process.argv[2];
const requested = process.argv[3];
const verify = process.argv.includes('--verify');
if (!filename || !requested)
  throw new Error('Usage: inspect-pages.ts <pdf> <ranges>');

const require = createRequire(import.meta.url),
  pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json')),
  { createCanvas } = createRequire(path.join(pdfRoot, 'package.json'))(
    '@napi-rs/canvas',
  ),
  bytes = new Uint8Array(await fs.readFile(filename)),
  doc = await getDocument({
    data: bytes,
    standardFontDataUrl: pdfRoot + '/standard_fonts/',
    cMapUrl: pdfRoot + '/cmaps/',
    cMapPacked: true,
  }).promise,
  pages = parsePageRanges(requested, doc.numPages),
  output = path.resolve('tmp/pdfs/inspect-pages');

await fs.mkdir(output, { recursive: true });
const results: {
  info: ReturnType<typeof inferLayout> & { page: number };
  blocks: ReturnType<typeof detectPage>;
}[] = [];
for (const pageNumber of pages) {
  const page = await doc.getPage(pageNumber),
    viewport = page.getViewport({ scale: 1 }),
    text = await page.getTextContent(),
    spans: Span[] = text.items.flatMap((item) => {
      if (!('str' in item) || !item.str.trim()) return [];
      const transform = Util.transform(viewport.transform, item.transform),
        style = text.styles[item.fontName],
        height = Math.hypot(transform[2], transform[3]);
      return [
        {
          text: item.str,
          x: transform[4],
          y:
            transform[5] -
            height * (Number.isFinite(style.ascent) ? style.ascent : 0.85),
          w: item.width,
          h: height,
          baseline: transform[5],
          font: item.fontName + ' ' + style.fontFamily,
        },
      ];
    }),
    rendered = page.getViewport({ scale: 2 }),
    canvas = createCanvas(Math.ceil(rendered.width), Math.ceil(rendered.height));
  await page.render({ canvas, viewport: rendered }).promise;
  const context = canvas.getContext('2d'),
    ink = inkFromRgba(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
      2,
    ),
    info = {
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      spans,
      ...inferLayout(viewport.width, viewport.height, spans, ink),
    },
    blocks = detectPage(info, ink);
  results.push({ info, blocks });

  context.lineWidth = 1.5;
  context.font = '14px sans-serif';
  for (const block of blocks) {
    const rect = block.fragments[0].rect;
    context.strokeStyle =
      block.kind === 'problem'
        ? '#165ce0'
        : block.kind === 'instruction'
          ? '#c88300'
          : '#d14343';
    context.strokeRect(rect.x * 2, rect.y * 2, rect.w * 2, rect.h * 2);
    context.fillStyle = context.strokeStyle;
    context.fillText(block.label, rect.x * 2, Math.max(14, rect.y * 2 - 3));
  }
  await fs.writeFile(
    path.join(output, `page-${pageNumber}.png`),
    canvas.toBuffer('image/png'),
  );
  await fs.writeFile(
    path.join(output, `page-${pageNumber}.json`),
    JSON.stringify({ info, blocks }, null, 2),
  );
  console.log(
    JSON.stringify({
      page: pageNumber,
      body: info.body,
      regions: info.regions,
      blocks: blocks.map((block) => ({
        label: block.label,
        kind: block.kind,
        rect: block.fragments[0].rect,
      })),
    }),
  );
}
if (verify) {
  const byPage = (page: number) => results.find((result) => result.info.page === page)!;
  const problemNumbers = (page: number) =>
    byPage(page).blocks
      .filter((block) => block.kind === 'problem')
      .map((block) => Number(block.label));
  const sequence = (start: number, end: number) =>
    Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const hasHeading = (page: number, heading: RegExp) =>
    byPage(page).blocks.some(
      (block) => block.kind === 'instruction' && heading.test(block.label),
    );

  assert.ok(byPage(141).info.body.y > 200, 'Page 141 excludes prior concept text');
  assert.equal(byPage(141).info.regions?.length, 2, 'Page 141 has one header band and two-column exercises');
  assert.ok(hasHeading(141, /^4\.1\.1\s+Initial-Value and Boundary-Value Problems$/i));
  assert.ok(hasHeading(141, /^4\.1\.2\s+Homogeneous Equations$/i));
  assert.deepEqual(problemNumbers(141), sequence(1, 16));
  assert.equal(byPage(142).info.regions?.length, 1, 'Page 142 has no thin full-width bands');
  assert.ok(hasHeading(142, /^4\.1\.3\s+Nonhomogeneous Equations$/i));
  assert.ok(hasHeading(142, /^Discussion Problems$/i));
  assert.deepEqual(problemNumbers(142), sequence(17, 42));

  assert.ok(byPage(145).info.body.y > 340, 'Page 145 excludes prior concept text');
  assert.equal(byPage(145).info.regions?.length, 2);
  assert.deepEqual(problemNumbers(145), sequence(1, 23));
  assert.ok(byPage(146).info.body.y + byPage(146).info.body.h < 170);
  assert.deepEqual(problemNumbers(146), [24, 25]);

  assert.ok(byPage(151).info.body.y > 380, 'Page 151 excludes prior concept text');
  assert.equal(byPage(151).info.regions?.length, 2);
  assert.deepEqual(problemNumbers(151), sequence(1, 32));
  assert.equal(byPage(152).info.regions?.length, 1);
  assert.ok(hasHeading(152, /^Discussion Problems$/i));
  assert.deepEqual(problemNumbers(152), sequence(33, 61));
  assert.ok(
    byPage(153).info.body.y + byPage(153).info.body.h < 300,
    'Page 153 excludes section 4.4 concept text',
  );
  assert.equal(byPage(153).info.regions?.length, 1);
  assert.deepEqual(problemNumbers(153), sequence(62, 70));

  assert.ok(byPage(161).info.body.y > 500, 'Page 161 excludes prior concept text');
  assert.equal(byPage(161).info.regions?.length, 2);
  assert.deepEqual(problemNumbers(161), sequence(1, 17));
  assert.equal(byPage(162).info.regions?.length, 1);
  assert.deepEqual(problemNumbers(162), sequence(18, 48));
  assert.ok(
    byPage(163).info.body.y + byPage(163).info.body.h < 130,
    'Page 163 excludes section 4.5 concept text',
  );
  assert.deepEqual(problemNumbers(163), [49, 50]);
  assert.ok(hasHeading(163, /^Computer Lab Assignments$/i));

  const linked = linkContinuations(results.flatMap((result) => result.blocks));
  assert.equal(
    linked.find(
      (block) =>
        block.kind === 'problem' &&
        block.label === '25' &&
        block.fragments.some((fragment) => fragment.page === 146),
    )
      ?.fragments.length,
    2,
    'Problem 25 links to its right-column continuation',
  );
  assert.equal(
    linked.find(
      (block) => block.kind === 'instruction' && block.range?.[0] === 65,
    )?.fragments.length,
    2,
    'The 65-68 common instruction continues into the right column',
  );
  assert.equal(
    linked.find(
      (block) =>
        block.kind === 'problem' &&
        block.label === '43' &&
        block.fragments.some((fragment) => fragment.page === 162),
    )
      ?.fragments.length,
    2,
    'Problem 43 links across source columns without changing crop width policy',
  );
  assert.deepEqual(numberAudit(linked), { missing: [], duplicates: [] });
  console.log('PASS: requested real-PDF page ranges');
}
await doc.destroy();
