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
import { formatPageRanges, parsePageRanges } from '../lib/section-ranges';
import { POST as locateSections } from '../api/locate-sections';
import {
  extractSectionIds,
  selectCandidatePages,
} from '../lib/ai-section-search';
import type { Block, Ink, PageInfo, Span, Settings } from '../lib/model';

const require = createRequire(import.meta.url),
  pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

assert.deepEqual(parsePageRanges('23-26, 29-30', 40), [
  23, 24, 25, 26, 29, 30,
]);
assert.equal(formatPageRanges([30, 23, 24, 25, 26, 29, 29]), '23-26, 29-30');
assert.throws(() => parsePageRanges('23-20', 40));
assert.throws(() => parsePageRanges('41', 40));
assert.deepEqual(extractSectionIds('4.1, 4.2, 4.3, 4.4 연습문제'), [
  '4.1',
  '4.2',
  '4.3',
  '4.4',
]);
const longBook = Array.from({ length: 462 }, (_, index) => ({
  page: index + 1,
  text: `Chapter text on PDF page ${index + 1}`,
}));
longBook[9].text = 'CONTENTS EXERCISES 4.1 EXERCISES 4.2 EXERCISES 4.3 EXERCISES 4.4';
longBook[199].text = 'EXERCISES 4.1 1. Solve. 2. Solve. 3. Solve.';
longBook[209].text = 'EXERCISES 4.2 1. Solve. 2. Solve. 3. Solve.';
longBook[219].text = 'EXERCISES 4.3 1. Solve. 2. Solve. 3. Solve.';
longBook[229].text = 'EXERCISES 4.4 1. Solve. 2. Solve. 3. Solve.';
longBook[239].text = 'EXERCISES 4.5 1. Solve. 2. Solve. 3. Solve.';
const candidatePages = selectCandidatePages(
  '4.1, 4.2, 4.3, 4.4 연습문제 전부',
  longBook,
);
assert.ok(candidatePages.length <= 40, 'Paid AI input is strictly bounded');
for (const expected of [200, 210, 220, 230, 240])
  assert.ok(
    candidatePages.some((page) => page.page === expected),
    `Candidate evidence includes PDF page ${expected}`,
  );

const originalFetch = globalThis.fetch;
process.env.OPENAI_API_KEY = 'test-key';
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                normalized_request: 'Exercises 4.1-4.4',
                ranges: [
                  {
                    label: 'Exercises 4.1',
                    start: 23,
                    end: 26,
                    confidence: 0.96,
                    reason: '연속된 문제 번호',
                  },
                ],
              }),
            },
          ],
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
const aiResponse = await locateSections(
  new Request('https://problembook-cutter.vercel.app/api/locate-sections', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
    },
    body: JSON.stringify({
      request: '4.1, 4.2, 4.3, 4.4 연습문제 전부',
      pageCount: 40,
      pages: [{ page: 23, text: 'EXERCISES 4.1 1. Solve the equation.' }],
    }),
  }),
);
assert.equal(aiResponse.status, 200);
assert.equal(aiResponse.headers.get('access-control-allow-origin'), 'http://localhost:3000');
const aiResult = (await aiResponse.json()) as { ranges: unknown[] };
assert.deepEqual(aiResult.ranges[0], {
  label: 'Exercises 4.1',
  start: 23,
  end: 26,
  confidence: 0.96,
  reason: '연속된 문제 번호',
});
globalThis.fetch = originalFetch;
delete process.env.OPENAI_API_KEY;
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
const all: Block[] = [],
  infos: PageInfo[] = [];
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
  infos.push(info);
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
  if (filename && doc.numPages === 1) {
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

// A synthetic inverted-T page: two columns above, one full-width band below.
const syntheticInk: Ink = {
    width: 1200,
    height: 1600,
    scale: 2,
    data: new Uint8Array(1200 * 1600),
  },
  syntheticSpans: Span[] = [
    { text: '1.', x: 40, y: 100, w: 12, h: 10, baseline: 110, font: 'bold' },
    { text: '2.', x: 330, y: 100, w: 12, h: 10, baseline: 110, font: 'bold' },
    { text: '3.', x: 40, y: 300, w: 12, h: 10, baseline: 310, font: 'bold' },
    { text: '4.', x: 330, y: 300, w: 12, h: 10, baseline: 310, font: 'bold' },
    {
      text: 'Shared full-width instruction at the bottom',
      x: 40,
      y: 600,
      w: 500,
      h: 10,
      baseline: 610,
      font: 'regular',
    },
  ];
for (const span of syntheticSpans)
  for (let y = span.y * 2; y < (span.y + span.h) * 2; y++)
    syntheticInk.data.fill(
      1,
      y * syntheticInk.width + span.x * 2,
      y * syntheticInk.width + (span.x + span.w) * 2,
    );
const invertedT = inferLayout(600, 800, syntheticSpans, syntheticInk);
assert.ok(
  invertedT.regions?.[0].columns.length === 1 &&
    invertedT.regions.at(-1)?.columns.length === 0,
  'Mixed layout supports two columns changing to one column',
);

// A decorative horizontal rule must not turn a two-column page into a thin
// full-width layout region.
const ruledInk: Ink = {
    width: 1200,
    height: 1600,
    scale: 2,
    data: new Uint8Array(1200 * 1600),
  },
  ruledSpans: Span[] = [
    { text: '1.', x: 40, y: 100, w: 12, h: 10, baseline: 110, font: 'bold' },
    { text: '11.', x: 330, y: 100, w: 18, h: 10, baseline: 110, font: 'bold' },
    { text: '2.', x: 40, y: 500, w: 12, h: 10, baseline: 510, font: 'bold' },
    { text: '12.', x: 330, y: 500, w: 18, h: 10, baseline: 510, font: 'bold' },
    {
      text: 'x(t) = a very wide equation that slightly crosses the gutter',
      x: 170,
      y: 340,
      w: 250,
      h: 10,
      baseline: 350,
      font: 'regular',
    },
  ];
for (const span of ruledSpans)
  for (let y = span.y * 2; y < (span.y + span.h) * 2; y++)
    ruledInk.data.fill(
      1,
      y * ruledInk.width + span.x * 2,
      y * ruledInk.width + (span.x + span.w) * 2,
    );
ruledInk.data.fill(1, 700 * ruledInk.width + 70, 700 * ruledInk.width + 1130);
const ruledLayout = inferLayout(600, 800, ruledSpans, ruledInk);
assert.ok(
  ruledLayout.regions?.every((region) => region.columns.length === 1),
  'A long rule or incidental wide equation does not create a full-width object',
);

const nextSectionInk: Ink = {
    width: 1200,
    height: 1600,
    scale: 2,
    data: new Uint8Array(1200 * 1600),
  },
  nextSectionSpans: Span[] = [
    { text: 'EXERCISES 4.3', x: 40, y: 70, w: 150, h: 14, baseline: 84, font: 'bold' },
    { text: '1.', x: 40, y: 120, w: 12, h: 10, baseline: 130, font: 'bold' },
    { text: '21.', x: 330, y: 120, w: 18, h: 10, baseline: 130, font: 'bold' },
    { text: '4.4', x: 40, y: 500, w: 42, h: 12, baseline: 512, font: 'bold' },
    {
      text: 'Undetermined Coefficients',
      x: 100,
      y: 500,
      w: 260,
      h: 12,
      baseline: 512,
      font: 'bold',
    },
    { text: 'INTRODUCTION', x: 100, y: 550, w: 100, h: 10, baseline: 560, font: 'bold' },
  ];
for (const span of nextSectionSpans)
  for (let y = span.y * 2; y < (span.y + span.h) * 2; y++)
    nextSectionInk.data.fill(
      1,
      y * nextSectionInk.width + span.x * 2,
      y * nextSectionInk.width + (span.x + span.w) * 2,
    );
const nextSectionLayout = inferLayout(600, 800, nextSectionSpans, nextSectionInk);
assert.ok(
  nextSectionLayout.body.y + nextSectionLayout.body.h < 500,
  'A split next-section title excludes following concept material',
);

// Equation numbers must not masquerade as right-column problem anchors, and a
// solid scanned-page strip must not enlarge every crop to the physical edge.
const edgeInk: Ink = {
    width: 1200,
    height: 1600,
    scale: 2,
    data: new Uint8Array(1200 * 1600),
  },
  edgeSpans: Span[] = [
    { text: '1.', x: 40, y: 100, w: 12, h: 10, baseline: 110, font: 'regular' },
    {
      text: 'x =',
      x: 190,
      y: 100,
      w: 26,
      h: 10,
      baseline: 110,
      font: 'regular',
    },
    {
      text: '2.',
      x: 220,
      y: 100,
      w: 12,
      h: 10,
      baseline: 110,
      font: 'regular',
    },
    {
      text: '21.',
      x: 330,
      y: 100,
      w: 18,
      h: 10,
      baseline: 110,
      font: 'regular',
    },
    { text: '3.', x: 40, y: 300, w: 12, h: 10, baseline: 310, font: 'regular' },
    {
      text: '22.',
      x: 330,
      y: 300,
      w: 18,
      h: 10,
      baseline: 310,
      font: 'regular',
    },
  ];
for (const span of edgeSpans)
  for (let y = span.y * 2; y < (span.y + span.h) * 2; y++)
    edgeInk.data.fill(
      1,
      y * edgeInk.width + span.x * 2,
      y * edgeInk.width + (span.x + span.w) * 2,
    );
for (let y = 0; y < edgeInk.height; y++)
  edgeInk.data.fill(1, y * edgeInk.width + 1140, y * edgeInk.width + 1200);
const cleanEdges = inferLayout(600, 800, edgeSpans, edgeInk);
assert.ok(
  cleanEdges.columns[0] > 280,
  'An equation number cannot pull the column divider into the left column',
);
assert.ok(
  cleanEdges.body.x + cleanEdges.body.w < 570,
  'A solid page-edge strip is excluded from the content boundary',
);

const reviewInk: Ink = {
    width: 1200,
    height: 800,
    scale: 2,
    data: new Uint8Array(1200 * 800),
  },
  reviewSpans: Span[] = [
    {
      text: 'Answers to selected odd-numbered problems',
      x: 40,
      y: 60,
      w: 500,
      h: 12,
      baseline: 70,
      font: 'regular',
    },
    {
      text: 'Answer Problems 1–10 without referring back to the text.',
      x: 40,
      y: 100,
      w: 230,
      h: 10,
      baseline: 110,
      font: 'regular',
    },
    { text: '1.', x: 40, y: 130, w: 12, h: 10, baseline: 140, font: 'regular' },
    {
      text: '13.',
      x: 330,
      y: 100,
      w: 18,
      h: 10,
      baseline: 110,
      font: 'regular',
    },
  ];
for (const span of reviewSpans)
  for (let y = span.y * 2; y < (span.y + span.h) * 2; y++)
    reviewInk.data.fill(
      1,
      y * reviewInk.width + span.x * 2,
      y * reviewInk.width + (span.x + span.w) * 2,
    );
const reviewBlocks = detectPage(
  {
    page: 1,
    width: 600,
    height: 400,
    spans: reviewSpans,
    body: { x: 32, y: 55, w: 512, h: 200 },
    columns: [287],
    regions: [
      { x: 32, y: 55, w: 512, h: 35, columns: [] },
      { x: 32, y: 90, w: 512, h: 165, columns: [287] },
    ],
  },
  reviewInk,
);
assert.equal(
  reviewBlocks.find((b) => b.range?.[0] === 1)?.label,
  '1–10 공통 지시문',
  'Answer Problems ranges are common instructions, not exercise headers',
);

// Headings split into distant PDF text spans still form their own block.
const splitHeadingInk: Ink = {
    width: 1200,
    height: 800,
    scale: 2,
    data: new Uint8Array(1200 * 800),
  },
  splitHeadingSpans: Span[] = [
    { text: '22.', x: 40, y: 70, w: 18, h: 10, baseline: 80, font: 'bold' },
    { text: 'Solve.', x: 62, y: 70, w: 60, h: 10, baseline: 80, font: 'regular' },
    { text: 'Discussion', x: 40, y: 150, w: 65, h: 13, baseline: 163, font: 'bold' },
    { text: 'Problems', x: 120, y: 150, w: 55, h: 13, baseline: 163, font: 'bold' },
    { text: '23.', x: 40, y: 190, w: 18, h: 10, baseline: 200, font: 'bold' },
    { text: 'Discuss.', x: 62, y: 190, w: 80, h: 10, baseline: 200, font: 'regular' },
  ];
for (const span of splitHeadingSpans)
  for (let y = span.y * 2; y < (span.y + span.h) * 2; y++)
    splitHeadingInk.data.fill(
      1,
      y * splitHeadingInk.width + span.x * 2,
      y * splitHeadingInk.width + (span.x + span.w) * 2,
    );
const splitHeadingBlocks = detectPage(
  {
    page: 1,
    width: 600,
    height: 400,
    spans: splitHeadingSpans,
    body: { x: 32, y: 50, w: 250, h: 190 },
    columns: [],
    regions: [{ x: 32, y: 50, w: 250, h: 190, columns: [] }],
  },
  splitHeadingInk,
);
assert.ok(
  splitHeadingBlocks.some(
    (block) =>
      block.kind === 'instruction' && /^Discussion Problems/i.test(block.label),
  ),
  'A split Discussion Problems heading is separated from the prior problem',
);
assert.equal(
  splitHeadingBlocks.find((block) => block.label === '22')?.fragments[0].rect.w,
  250,
  'Problem crops retain the complete source-column width',
);

const continuationBlocks: Block[] = [
  {
    id: 'p43',
    label: '43',
    kind: 'problem',
    fragments: [{ id: 'p43-a', page: 1, rect: { x: 320, y: 300, w: 240, h: 80 } }],
    selected: true,
    reviewed: false,
    warnings: [],
  },
  {
    id: 'p18',
    label: '18',
    kind: 'problem',
    fragments: [{ id: 'p18-a', page: 2, rect: { x: 40, y: 60, w: 240, h: 300 } }],
    selected: true,
    reviewed: false,
    warnings: [],
  },
  {
    id: 'continued',
    label: '이어짐 / 미분류',
    kind: 'unassigned',
    fragments: [{ id: 'p43-b', page: 2, rect: { x: 320, y: 60, w: 240, h: 220 } }],
    selected: true,
    reviewed: false,
    warnings: ['단 또는 페이지 앞부분입니다. 이전 문제와 이어지는지 확인하세요'],
  },
  {
    id: 'p44',
    label: '44',
    kind: 'problem',
    fragments: [{ id: 'p44-a', page: 2, rect: { x: 320, y: 280, w: 240, h: 80 } }],
    selected: true,
    reviewed: false,
    warnings: [],
  },
];
assert.equal(
  linkContinuations(continuationBlocks).find((block) => block.label === '43')
    ?.fragments.length,
  2,
  'A right-column continuation links to the number before the next problem',
);
assert.deepEqual(
  numberAudit(
    [1, 2, 3, 1, 2, 3].map((number, index) => ({
      id: `audit-${index}`,
      label: String(number),
      kind: 'problem' as const,
      fragments: [
        { id: `audit-fragment-${index}`, page: index + 1, rect: { x: 0, y: 0, w: 1, h: 1 } },
      ],
      selected: true,
      reviewed: false,
      warnings: [],
    })),
  ),
  { missing: [], duplicates: [] },
  'Repeated numbering in separate requested sections is not a duplicate warning',
);
if (filename) {
  const expected =
    doc.numPages === 4
      ? Array.from({ length: 64 }, (_, i) => i + 1)
      : Array.from({ length: 35 }, (_, i) => i + 12);
  assert.deepEqual(
    blocks.filter((b) => b.kind === 'problem').map((b) => +b.label),
    expected,
  );
  assert.deepEqual(audit, { missing: [], duplicates: [] });
  if (doc.numPages === 4) {
    assert.ok(infos[0].body.y > 450, 'Previous concept is excluded on page 1');
    assert.ok(
      infos[0].regions?.some((r) => r.columns.length === 0) &&
        infos[0].regions?.some((r) => r.columns.length === 1),
      'Page 1 keeps both full-width and two-column regions',
    );
    assert.ok(
      infos[3].body.y + infos[3].body.h < 360,
      'Following concept is excluded on page 4',
    );
    assert.equal(
      blocks.filter((b) => b.kind === 'problem' && b.label === '54').length,
      1,
      'Problem 54 remains a problem',
    );
    assert.equal(
      blocks.find((b) => b.kind === 'instruction' && b.range?.[0] === 63)
        ?.fragments.length,
      2,
      'A common instruction can continue into the next source column',
    );
  }
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
  excludeHeaders: true,
  title: '',
};
const placements = layoutBook(blocks, settings);
assert.equal(
  placements.length,
  blocks.filter((b) => b.kind !== 'instruction' && b.selected).length,
);
for (const p of placements) {
  assert.ok(
    p.y + p.contentHeight + p.answerHeight <= 841.89 - 34 + 0.1,
    `Placement stays on A4: ${JSON.stringify(p)}`,
  );
  for (const f of p.fragments)
    assert.ok(
      p.x + f.rect.w * p.scale <= 595.276 - 34 + 0.1,
      `Problem ${p.blockId} stays inside the A4 printable width`,
    );
}
assert.ok(
  Math.max(...placements.map((p) => p.scale)) >= 0.9,
  'Source page width is mapped near the full printable A4 width',
);
const headerBlock: Block = {
    id: 'header',
    label: '연습문제 머리말',
    kind: 'instruction',
    selected: true,
    reviewed: true,
    warnings: [],
    fragments: [
      { id: 'header-fragment', page: 1, rect: { x: 0, y: 0, w: 500, h: 30 } },
    ],
  },
  problemBlock: Block = {
    id: 'problem',
    label: '1',
    kind: 'problem',
    selected: true,
    reviewed: true,
    warnings: [],
    fragments: [
      { id: 'problem-fragment', page: 1, rect: { x: 0, y: 40, w: 250, h: 30 } },
    ],
  };
assert.deepEqual(
  layoutBook([headerBlock, problemBlock], settings)[0].fragments,
  problemBlock.fragments,
  'Exercise headers are excluded from output by default',
);
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
