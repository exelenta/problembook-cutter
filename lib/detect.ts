import {
  bottom,
  right,
  uid,
  type Block,
  type Ink,
  type PageInfo,
  type Rect,
  type Span,
} from './model';

// All geometry is in the displayed PDF viewport's points (top-left origin).
// Text only identifies anchors. Pixel occupancy decides crop boundaries.
export function inkFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
): Ink {
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] =
      data[i * 4 + 3] > 50 &&
      Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) < 215
        ? 1
        : 0;
  return { width, height, scale, data: pixels };
}
export function projection(ink: Ink, rect: Rect, axis: 'x' | 'y') {
  const { scale: s, width, height, data } = ink;
  const x0 = Math.max(0, Math.floor(rect.x * s)),
    x1 = Math.min(width, Math.ceil(right(rect) * s));
  const y0 = Math.max(0, Math.floor(rect.y * s)),
    y1 = Math.min(height, Math.ceil(bottom(rect) * s));
  const values = new Uint32Array(axis === 'x' ? width : height);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (data[y * width + x]) values[axis === 'x' ? x : y]++;
  return values;
}
export function trim(ink: Ink, r: Rect, pad = 2): Rect {
  const xs = projection(ink, r, 'x'),
    ys = projection(ink, r, 'y'),
    s = ink.scale;
  const occupied = (v: Uint32Array) => {
    const a = v.findIndex((n) => n > 0);
    let b = v.length - 1;
    while (b >= 0 && !v[b]) b--;
    return [a, b + 1];
  };
  const [x0, x1] = occupied(xs),
    [y0, y1] = occupied(ys);
  if (x0 < 0 || y0 < 0) return r;
  const x = Math.max(r.x, x0 / s - pad),
    y = Math.max(r.y, y0 / s - pad);
  return {
    x,
    y,
    w: Math.min(right(r), x1 / s + pad) - x,
    h: Math.min(bottom(r), y1 / s + pad) - y,
  };
}
function gaps(values: Uint32Array, from: number, to: number, scale: number) {
  const out: { a: number; b: number }[] = [];
  let start = -1;
  for (
    let i = Math.max(0, Math.ceil(from * scale));
    i <= Math.min(values.length - 1, Math.floor(to * scale));
    i++
  ) {
    if (values[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push({ a: start / scale, b: i / scale });
      start = -1;
    }
  }
  if (start >= 0)
    out.push({ a: start / scale, b: Math.min(values.length / scale, to) });
  return out;
}
export function safeCut(
  ink: Ink,
  r: Rect,
  axis: 'x' | 'y',
  wanted: number,
  radius = 12,
) {
  const p = projection(ink, r, axis),
    lo = axis === 'x' ? r.x : r.y,
    hi = axis === 'x' ? right(r) : bottom(r);
  const gs = gaps(
    p,
    Math.max(lo, wanted - radius),
    Math.min(hi, wanted + radius),
    ink.scale,
  ).filter((g) => g.b - g.a >= 1);
  gs.sort(
    (a, b) =>
      Math.abs((a.a + a.b) / 2 - wanted) - Math.abs((b.a + b.b) / 2 - wanted),
  );
  return gs[0] ? (gs[0].a + gs[0].b) / 2 : wanted;
}
export function edgeWarnings(ink: Ink, r: Rect): string[] {
  const s = ink.scale,
    x0 = Math.round(r.x * s),
    x1 = Math.round(right(r) * s),
    y0 = Math.round(r.y * s),
    y1 = Math.round(bottom(r) * s);
  const at = (x: number, y: number) => ink.data[y * ink.width + x] || 0;
  let h = 0,
    v = 0;
  for (let x = x0; x < x1; x++) {
    if (at(x, y0 - 1) && at(x, y0)) h++;
    if (at(x, y1 - 1) && at(x, y1)) h++;
  }
  for (let y = y0; y < y1; y++) {
    if (at(x0 - 1, y) && at(x0, y)) v++;
    if (at(x1 - 1, y) && at(x1, y)) v++;
  }
  return [
    ...(h ? ['가로 경계가 원본 잉크와 겹칩니다'] : []),
    ...(v ? ['세로 경계가 원본 잉크와 겹칩니다'] : []),
  ];
}
export function inferLayout(
  width: number,
  height: number,
  spans: Span[],
  ink: Ink,
): Pick<PageInfo, 'body' | 'columns'> {
  // Exclude running headers/footers conservatively; user can move every limit.
  const initial = {
    x: width * 0.035,
    y: height * 0.068,
    w: width * 0.93,
    h: height * 0.89,
  };
  const body = trim(ink, initial, 4);
  const nums = spans.filter(
    (t) =>
      /^\d{1,3}[.)](?:\s|$)/.test(t.text.trim()) &&
      t.y >= body.y &&
      bottom(t) <= bottom(body),
  );
  const xs = nums.map((t) => t.x).sort((a, b) => a - b);
  const left = xs[0] ?? body.x;
  const second = xs.find(
    (x) => x - left > width * 0.3 && x - left < width * 0.56,
  );
  const p = projection(ink, body, 'x');
  const center = second !== undefined ? second - 7 : body.x + body.w / 2;
  const gs = gaps(
    p,
    Math.max(body.x + body.w * 0.3, center - width * 0.045),
    Math.min(right(body) - body.w * 0.2, center + width * 0.045),
    ink.scale,
  ).filter((g) => g.b - g.a >= 4);
  gs.sort((a, b) => b.b - b.a - (a.b - a.a));
  return { body, columns: gs.length ? [(gs[0].a + gs[0].b) / 2] : [] };
}
type Event = {
  span: Span;
  kind: Block['kind'];
  label: string;
  range?: [number, number];
};
function events(spans: Span[], r: Rect): Event[] {
  const inside = spans.filter(
    (t) =>
      t.x >= r.x &&
      t.x < right(r) &&
      t.baseline >= r.y &&
      t.baseline < bottom(r),
  );
  const es: Event[] = [];
  for (const t of inside) {
    const text = t.text.trim();
    const m = text.match(/^(\d{1,3})[.)](?:\s|$)/);
    if (
      m &&
      +m[1] > 0 &&
      (t.x - r.x < 24 ||
        (/^\d{1,3}[.)]$/.test(text) &&
          !inside.some(
            (s) =>
              s.x < t.x &&
              right(s) > t.x - 12 &&
              Math.abs(s.baseline - t.baseline) < 3 &&
              s.text.trim(),
          )) ||
        /bold|black|demi/i.test(t.font))
    )
      es.push({ span: t, kind: 'problem', label: m[1] });
    else if (/^In\s+(?:Problems?|Exercises?)\s+\d/i.test(text)) {
      const line = inside
        .filter((s) => Math.abs(s.baseline - t.baseline) < 3 && s.x >= t.x)
        .sort((a, b) => a.x - b.x)
        .map((s) => s.text)
        .join(' ');
      const range = line.match(
        /(?:Problems?|Exercises?)\s+(\d+)\s*(?:[–—-]|and|through|to)\s*(\d+)/i,
      );
      es.push({
        span: t,
        kind: 'instruction',
        label: range ? `${range[1]}–${range[2]} 공통 지시문` : '공통 지시문',
        range: range ? [+range[1], +range[2]] : undefined,
      });
    } else if (
      /^(?:Discussion Problems|Computer Lab|Exercises?\s*\d|Answers\b|Chapter\s+\d)/i.test(
        text,
      )
    )
      es.push({ span: t, kind: 'instruction', label: text });
  }
  return es
    .filter(
      (e, i) =>
        !es
          .slice(0, i)
          .some(
            (a) =>
              a.kind === e.kind &&
              a.label === e.label &&
              Math.abs(a.span.x - e.span.x) < 2 &&
              Math.abs(a.span.y - e.span.y) < 2,
          ),
    )
    .sort((a, b) =>
      Math.abs(a.span.baseline - b.span.baseline) < 4
        ? a.span.x - b.span.x
        : a.span.baseline - b.span.baseline,
    );
}
export function detectPage(info: PageInfo, ink: Ink): Block[] {
  const blocks: Block[] = [];
  const bounds = [
    info.body.x,
    ...info.columns
      .filter((x) => x > info.body.x && x < right(info.body))
      .sort((a, b) => a - b),
    right(info.body),
  ];
  for (let c = 0; c < bounds.length - 1; c++) {
    const col = { ...info.body, x: bounds[c], w: bounds[c + 1] - bounds[c] };
    const es = events(info.spans, col);
    const make = (r: Rect, e?: Event, extra: string[] = []) => {
      const crop = trim(ink, r, 2);
      if (!projection(ink, crop, 'y').some((v) => v > 0)) return;
      blocks.push({
        id: uid(),
        label: e?.label ?? '이어짐 / 미분류',
        kind: e?.kind ?? 'unassigned',
        range: e?.range,
        fragments: [{ id: uid(), page: info.page, rect: crop }],
        selected: true,
        reviewed: false,
        warnings: [...edgeWarnings(ink, crop), ...extra],
      });
    };
    if (!es.length) {
      make(col, undefined, [
        '문제 번호를 찾지 못했습니다. 영역을 직접 분할하세요',
      ]);
      continue;
    }
    const rows: Event[][] = [];
    for (const e of es) {
      const last = rows.at(-1);
      if (
        last &&
        Math.abs(last[0].span.baseline - e.span.baseline) < 4 &&
        e.kind === 'problem' &&
        last[0].kind === 'problem'
      )
        last.push(e);
      else rows.push([e]);
    }
    const ys = projection(ink, col, 'y');
    const cuts = rows.map((row, i) => {
      const baseline = row[0].span.baseline,
        prev = i ? rows[i - 1][0].span.baseline : col.y;
      const gs = gaps(
        ys,
        prev + (i ? 4 : 0),
        baseline - Math.max(5, row[0].span.h * 0.9),
        ink.scale,
      ).filter((g) => g.b - g.a >= 1.5);
      // Prefer the last substantial band. Earlier gaps may be inside a problem.
      const substantial = gs.filter((g) => g.b - g.a >= 3);
      const gap =
        substantial.at(-1) ?? gs.sort((a, b) => b.b - b.a - (a.b - a.a))[0];
      return gap ? (gap.a + gap.b) / 2 : Math.max(col.y, row[0].span.y - 5);
    });
    if (cuts[0] > col.y + 2)
      make({ ...col, h: cuts[0] - col.y }, undefined, [
        '단 또는 페이지 앞부분입니다. 이전 문제와 이어지는지 확인하세요',
      ]);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        y = cuts[i],
        end = cuts[i + 1] ?? bottom(col),
        r = { ...col, y, h: Math.max(1, end - y) };
      const splits = [col.x];
      for (let j = 1; j < row.length; j++)
        splits.push(safeCut(ink, r, 'x', row[j].span.x - 6, 14));
      splits.push(right(col));
      row.forEach((e, j) =>
        make({ ...r, x: splits[j], w: splits[j + 1] - splits[j] }, e, [
          ...(i === rows.length - 1 && e.kind === 'problem'
            ? ['단 끝 문제: 다음 단·페이지와 이어지는지 확인하세요']
            : []),
          ...(row.length > 1
            ? ['한 줄에 나란히 놓인 문제: 가운데 경계를 확인하세요']
            : []),
        ]),
      );
    }
  }
  return blocks;
}
export function linkContinuations(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out.at(-1);
    if (
      b.kind === 'unassigned' &&
      prev?.kind === 'problem' &&
      b.warnings.some((w) => w.includes('앞부분'))
    ) {
      out[out.length - 1] = {
        ...prev,
        fragments: [...prev.fragments, ...b.fragments],
        reviewed: false,
        warnings: [
          ...prev.warnings,
          '이어지는 조각을 임시 연결했습니다. 연결이 맞는지 확인하세요',
        ],
      };
    } else out.push(b);
  }
  return out;
}
export function numberAudit(blocks: Block[]) {
  const numbers = blocks
    .filter((b) => b.kind === 'problem')
    .map((b) => Number(b.label))
    .filter(Number.isFinite);
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  const missing: number[] = [];
  if (numbers.length) {
    for (
      let n = Math.min(...numbers);
      n <= Math.max(...numbers) && missing.length < 100;
      n++
    )
      if (!numbers.includes(n)) missing.push(n);
  }
  return { missing, duplicates: [...new Set(duplicates)] };
}

// Audits retained rectangles, including intentionally excluded blocks.
export function uncoveredRegions(
  info: PageInfo,
  ink: Ink,
  blocks: Block[],
): Rect[] {
  const { width, height, scale: s, data } = ink,
    covered = new Uint8Array(width * height);
  for (const b of blocks)
    for (const f of b.fragments) {
      if (f.page !== info.page) continue;
      const r = f.rect;
      for (
        let y = Math.max(0, Math.floor(r.y * s));
        y < Math.min(height, Math.ceil(bottom(r) * s));
        y++
      )
        covered.fill(
          1,
          y * width + Math.max(0, Math.floor(r.x * s)),
          y * width + Math.min(width, Math.ceil(right(r) * s)),
        );
    }
  const bounds = [info.body.x, ...info.columns, right(info.body)],
    out: Rect[] = [];
  for (let c = 0; c < bounds.length - 1; c++) {
    let minX = width,
      maxX = 0,
      minY = -1,
      maxY = 0,
      count = 0;
    const flush = () => {
      if (minY >= 0 && count >= 4)
        out.push({
          x: Math.max(bounds[c], minX / s - 1),
          y: Math.max(info.body.y, minY / s - 1),
          w:
            Math.min(bounds[c + 1], (maxX + 1) / s + 1) -
            Math.max(bounds[c], minX / s - 1),
          h:
            Math.min(bottom(info.body), (maxY + 1) / s + 1) -
            Math.max(info.body.y, minY / s - 1),
        });
      minX = width;
      maxX = 0;
      minY = -1;
      count = 0;
    };
    for (
      let y = Math.floor(info.body.y * s);
      y < Math.min(height, Math.ceil(bottom(info.body) * s));
      y++
    ) {
      if (minY >= 0 && y - maxY > s * 7) flush();
      for (
        let x = Math.max(0, Math.floor(bounds[c] * s));
        x < Math.min(width, Math.ceil(bounds[c + 1] * s));
        x++
      )
        if (data[y * width + x] && !covered[y * width + x]) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          if (minY < 0) minY = y;
          maxY = y;
          count++;
        }
    }
    flush();
  }
  return out;
}
