export type Rect = { x: number; y: number; w: number; h: number };
export type Span = Rect & { text: string; baseline: number; font: string };
export type Ink = {
  width: number;
  height: number;
  scale: number;
  data: Uint8Array;
};
export type Fragment = { id: string; page: number; rect: Rect };
export type Block = {
  id: string;
  label: string;
  kind: 'problem' | 'instruction' | 'unassigned';
  fragments: Fragment[];
  selected: boolean;
  reviewed: boolean;
  reviewedPages?: number[];
  warnings: string[];
  range?: [number, number];
};
export type LayoutRegion = Rect & { columns: number[] };
export type PageInfo = {
  page: number;
  width: number;
  height: number;
  spans: Span[];
  body: Rect;
  columns: number[];
  regions?: LayoutRegion[];
};
export type Settings = {
  columns: 1 | 2;
  answerMm: number;
  ruled: boolean;
  repeatInstructions: boolean;
  title: string;
};
export const uid = () => globalThis.crypto.randomUUID();
export const right = (r: Rect) => r.x + r.w;
export const bottom = (r: Rect) => r.y + r.h;
export const contains = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= right(r) && y >= r.y && y <= bottom(r);
export function validRect(r: Rect, width: number, height: number) {
  return (
    [r.x, r.y, r.w, r.h].every(Number.isFinite) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.w >= 1 &&
    r.h >= 1 &&
    right(r) <= width + 0.1 &&
    bottom(r) <= height + 0.1
  );
}
