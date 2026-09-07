import type { PDFDocumentProxy } from 'pdfjs-dist';
// oxlint-disable-next-line import/default -- Vite's ?url asset import has a default export.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { inkFromRgba, inferLayout } from './detect';
import type { Ink, PageInfo, Span } from './model';

let engine: Promise<typeof import('pdfjs-dist')> | undefined;
export async function pdfEngine() {
  if (!engine)
    engine = import('pdfjs-dist').then((pdf) => {
      pdf.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdf;
    });
  return engine;
}
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdf = await pdfEngine();
  return pdf.getDocument({
    data: bytes.slice(),
    cMapUrl: '/pdf-assets/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdf-assets/standard_fonts/',
    wasmUrl: '/pdf-assets/wasm/',
    isEvalSupported: false,
  }).promise;
}
export async function readSpans(
  doc: PDFDocumentProxy,
  page: number,
): Promise<{ width: number; height: number; spans: Span[] }> {
  const p = await doc.getPage(page),
    vp = p.getViewport({ scale: 1 }),
    content = await p.getTextContent();
  const pdf = await pdfEngine();
  const spans: Span[] = content.items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return [];
    const tx = pdf.Util.transform(vp.transform, item.transform),
      style = content.styles[item.fontName];
    const h = Math.hypot(tx[2], tx[3]),
      ascent = style.ascent ?? 0.85;
    return [
      {
        text: item.str,
        x: tx[4],
        y: tx[5] - h * ascent,
        w: item.width,
        h,
        baseline: tx[5],
        font: item.fontName + ' ' + (style.fontFamily ?? ''),
      },
    ];
  });
  return { width: vp.width, height: vp.height, spans };
}
export async function renderPage(
  doc: PDFDocumentProxy,
  page: number,
  scale = 2,
) {
  const p = await doc.getPage(page),
    vp = p.getViewport({ scale });
  if (vp.width * vp.height > 40_000_000)
    throw new Error(
      '페이지가 너무 큽니다. 더 작은 페이지로 PDF를 나눠 주세요.',
    );
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await p.render({ canvas, viewport: vp }).promise;
  return canvas;
}
export type Rendered = { info: PageInfo; ink: Ink; url: string };
export async function analyzePage(
  doc: PDFDocumentProxy,
  page: number,
): Promise<Rendered> {
  const text = await readSpans(doc, page),
    canvas = await renderPage(doc, page, 2),
    ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const ink = inkFromRgba(
    ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width,
    canvas.height,
    2,
  );
  const info = {
    page,
    ...text,
    ...inferLayout(text.width, text.height, text.spans, ink),
  };
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('페이지 이미지 생성 실패'))),
      'image/png',
    ),
  );
  canvas.width = 0;
  canvas.height = 0;
  return { info, ink, url: URL.createObjectURL(blob) };
}
export async function fingerprint(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function download(
  data: Uint8Array | string,
  name: string,
  type: string,
) {
  const blob = new Blob(
    [typeof data === 'string' ? data : data.slice().buffer],
    { type },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
