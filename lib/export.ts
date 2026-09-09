import {
  PDFDocument,
  PDFEmbeddedPage,
  StandardFonts,
  rgb,
  type PDFImage,
} from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type Block, type Fragment, type Settings } from './model';

export type Placement = {
  blockId: string;
  fragments: Fragment[];
  page: number;
  column: number;
  x: number;
  y: number;
  width: number;
  scale: number;
  contentHeight: number;
  answerHeight: number;
};
export function layoutBook(blocks: Block[], settings: Settings): Placement[] {
  if (
    !Number.isFinite(settings.answerMm) ||
    settings.answerMm < 0 ||
    settings.answerMm > 150
  )
    throw new Error('풀이 여백은 0~150 mm로 설정하세요.');
  const selected = blocks.filter(
    (b) =>
      b.selected && !(settings.excludeHeaders && b.label === '연습문제 머리말'),
  );
  const problems = selected.filter((b) => b.kind !== 'instruction');
  if (!problems.length) throw new Error('출력할 문제를 선택하세요.');
  const W = 595.276,
    H = 841.89,
    margin = 34,
    gutter = 22,
    top = settings.title ? 48 : 34,
    limit = H - 34,
    usableWidth = W - margin * 2;
  const width =
    (usableWidth - gutter * (settings.columns - 1)) / settings.columns;
  const maxW = Math.max(
    ...selected.flatMap((b) => b.fragments.map((f) => f.rect.w)),
  );
  // Preserve the source page's reading size: the widest source band maps to
  // the full usable A4 width. A full-width prompt must not shrink every crop
  // merely because the output itself uses two columns.
  const naturalScale = Math.min(1, usableWidth / maxW);
  let page = 0,
    col = 0,
    columnY = Array<number>(settings.columns).fill(top);
  const placements: Placement[] = [];
  const used = new Set<string>();
  const nextPage = () => {
    page++;
    col = 0;
    columnY = Array<number>(settings.columns).fill(top);
  };
  const nextColumn = () => {
    col++;
    if (col >= settings.columns) nextPage();
  };
  for (const b of problems) {
    const idx = blocks.indexOf(b),
      n = Number(b.label);
    const instructions = selected.filter(
      (s) =>
        s.kind === 'instruction' &&
        (s.range
          ? n >= s.range[0] && n <= s.range[1]
          : blocks.indexOf(s) < idx &&
            !blocks
              .slice(blocks.indexOf(s) + 1, idx)
              .some((x) => x.selected && x.kind !== 'instruction')) &&
        (settings.repeatInstructions || !used.has(s.id)),
    );
    instructions.forEach((s) => used.add(s.id));
    const fragments = [
      ...instructions.flatMap((s) => s.fragments),
      ...b.fragments,
    ];
    const rawHeight =
      fragments.reduce((sum, f) => sum + f.rect.h, 0) +
      Math.max(0, fragments.length - 1) * 5;
    const rawWidth = Math.max(...fragments.map((f) => f.rect.w));
    let scale = naturalScale,
      contentHeight = rawHeight * scale,
      answerHeight = (settings.answerMm * 72) / 25.4;
    // A problem, its shared prompt, and all continuation fragments are atomic.
    if (contentHeight + answerHeight > limit - top) {
      answerHeight = Math.max(0, limit - top - contentHeight);
      if (contentHeight > limit - top) {
        scale = (limit - top) / rawHeight;
        contentHeight = limit - top;
      }
    }
    if (scale < 0.45)
      throw new Error(
        `문제 ${b.label}가 너무 길어 읽기 어렵습니다. 1단 출력 또는 영역 분리를 선택하세요.`,
      );
    const spansPage = settings.columns === 1 || rawWidth * scale > width + 0.01;
    let y: number;
    if (spansPage) {
      y = Math.max(...columnY);
      if (y + contentHeight + answerHeight > limit + 0.01 && y > top) {
        nextPage();
        y = top;
      }
    } else {
      y = columnY[col];
      if (y + contentHeight + answerHeight > limit + 0.01) {
        nextColumn();
        y = columnY[col];
        // A preceding full-width placement can leave every output column at
        // the same filled height. Advancing just one column is then not enough.
        if (y + contentHeight + answerHeight > limit + 0.01 && y > top) {
          nextPage();
          y = top;
        }
      }
    }
    placements.push({
      blockId: b.id,
      fragments,
      page,
      column: spansPage ? 0 : col,
      x: spansPage ? margin : margin + col * (width + gutter),
      y,
      width: spansPage ? usableWidth : width,
      scale,
      contentHeight,
      answerHeight,
    });
    const nextY = y + contentHeight + answerHeight + 16;
    if (spansPage) {
      columnY.fill(nextY);
      col = 0;
    } else {
      columnY[col] = nextY;
    }
  }
  return placements;
}
export async function exportBook(
  bytes: Uint8Array,
  proxy: PDFDocumentProxy,
  blocks: Block[],
  settings: Settings,
  onProgress?: (s: string) => void,
): Promise<Uint8Array> {
  const placements = layoutBook(blocks, settings),
    src = await PDFDocument.load(bytes),
    out = await PDFDocument.create();
  out.setTitle(settings.title || 'Problem workbook');
  out.setProducer('Problembook Cutter');
  const font = await out.embedFont(StandardFonts.Helvetica),
    embedded = new Map<string, PDFEmbeddedPage | PDFImage>();
  for (let i = 0; i <= Math.max(...placements.map((p) => p.page)); i++) {
    const p = out.addPage([595.276, 841.89]);
    p.drawText(`${i + 1}`, {
      x: 289,
      y: 16,
      size: 8,
      font,
      color: rgb(0.45, 0.5, 0.55),
    });
    // Standard PDF fonts cannot encode Korean. The title is rendered locally as an image below.
  }
  if (settings.title) {
    const canvas = document.createElement('canvas');
    canvas.width = 1800;
    canvas.height = 90;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#405068';
    ctx.font = '36px Arial, "Malgun Gothic", sans-serif';
    ctx.fillText(settings.title.slice(0, 100), 0, 55, 1750);
    const title = await out.embedPng(canvas.toDataURL('image/png'));
    for (const p of out.getPages())
      p.drawImage(title, { x: 34, y: 808, width: 527, height: 26.35 });
  }
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i],
      page = out.getPage(p.page);
    let y = p.y;
    onProgress?.(`문제집 배치 ${i + 1} / ${placements.length}`);
    for (const f of p.fragments) {
      let item = embedded.get(f.id);
      if (!item) {
        const sourcePage = src.getPage(f.page - 1),
          pdfPage = await proxy.getPage(f.page),
          vp = pdfPage.getViewport({ scale: 1 });
        if (pdfPage.rotate === 0) {
          const a = vp.convertToPdfPoint(f.rect.x, f.rect.y),
            b = vp.convertToPdfPoint(f.rect.x + f.rect.w, f.rect.y + f.rect.h);
          item = await out.embedPage(sourcePage, {
            left: Math.min(a[0], b[0]),
            right: Math.max(a[0], b[0]),
            bottom: Math.min(a[1], b[1]),
            top: Math.max(a[1], b[1]),
          });
        } else {
          // Rotated pages use a 300 dpi crop in displayed coordinates.
          const scale = 300 / 72,
            canvas = document.createElement('canvas');
          canvas.width = Math.ceil(f.rect.w * scale);
          canvas.height = Math.ceil(f.rect.h * scale);
          if (canvas.width * canvas.height > 40_000_000)
            throw new Error(
              '회전된 문제 영역이 너무 큽니다. 영역을 줄여 주세요.',
            );
          await pdfPage.render({
            canvas,
            viewport: pdfPage.getViewport({ scale }),
            transform: [1, 0, 0, 1, -f.rect.x * scale, -f.rect.y * scale],
          }).promise;
          item = await out.embedPng(canvas.toDataURL('image/png'));
          canvas.width = 0;
          canvas.height = 0;
        }
        embedded.set(f.id, item);
      }
      const size = {
        x: p.x,
        y: 841.89 - y - f.rect.h * p.scale,
        width: f.rect.w * p.scale,
        height: f.rect.h * p.scale,
      };
      if (item instanceof PDFEmbeddedPage) page.drawPage(item, size);
      else page.drawImage(item, size);
      y += (f.rect.h + 5) * p.scale;
    }
    if (settings.ruled)
      for (
        let line = p.y + p.contentHeight + 18;
        line < p.y + p.contentHeight + p.answerHeight;
        line += 17
      )
        page.drawLine({
          start: { x: p.x, y: 841.89 - line },
          end: { x: p.x + p.width, y: 841.89 - line },
          thickness: 0.35,
          color: rgb(0.63, 0.72, 0.67),
        });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out.save();
}
