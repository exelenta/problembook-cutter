import {
  bottom,
  right,
  uid,
  type Block,
  type Ink,
  type LayoutRegion,
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
function excludeSolidEdgeFill(ink: Ink, r: Rect): Rect {
  // Scanned books and malformed PDF artwork sometimes leave a solid coloured
  // strip at the page edge. It is not problem content, but a normal bounding
  // box trim sees it as ink and stretches every crop to the strip.
  const xs = projection(ink, r, 'x'),
    s = ink.scale,
    y0 = Math.max(0, Math.floor(r.y * s)),
    y1 = Math.min(ink.height, Math.ceil(bottom(r) * s)),
    dense = Math.max(1, (y1 - y0) * 0.68),
    first = Math.max(0, Math.floor(r.x * s)),
    last = Math.min(ink.width, Math.ceil(right(r) * s)) - 1,
    minimum = Math.max(2, Math.ceil(2 * s));
  let left = first,
    rightEdge = last;
  while (left <= last && xs[left] >= dense) left++;
  while (rightEdge >= first && xs[rightEdge] >= dense) rightEdge--;
  const leftRun = left - first,
    rightRun = last - rightEdge;
  const x = leftRun >= minimum ? (left + 1) / s : r.x,
    end = rightRun >= minimum ? rightEdge / s : right(r);
  return { x, y: r.y, w: Math.max(1, end - x), h: r.h };
}
function gaps(
  values: Uint32Array,
  from: number,
  to: number,
  scale: number,
  maxValue = 0,
) {
  const out: { a: number; b: number }[] = [];
  let start = -1;
  for (
    let i = Math.max(0, Math.ceil(from * scale));
    i <= Math.min(values.length - 1, Math.floor(to * scale));
    i++
  ) {
    if (values[i] <= maxValue) {
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
): Pick<PageInfo, 'body' | 'columns' | 'regions'> {
  // Exclude running headers/footers conservatively, then look for exercise and
  // following-section landmarks. A page may change column count partway down.
  const initial = {
    x: width * 0.035,
    y: height * 0.068,
    w: width * 0.93,
    h: height * 0.89,
  };
  const initialRuns = textRuns(spans, initial);
  const exercise =
    initialRuns.find((run) =>
      /^Answers to selected (?:odd-numbered )?problems\b/i.test(run.text.trim()),
    ) ??
    initialRuns.find(
      (run) =>
        /^EXERCISES?\b/i.test(run.text.trim()) &&
        !spans.some(
          (span) =>
            span.baseline < run.baseline &&
            /^\d{1,3}[.)](?:\s|$)/.test(span.text.trim()),
        ),
    );
  const initialNumbers = spans
    .filter(
      (span) =>
        Number(span.text.trim().match(/^(\d{1,3})[.)](?:\s|$)/)?.[1]) > 0 &&
        span.baseline >= initial.y &&
        span.baseline < bottom(initial),
    )
    .sort((a, b) => a.baseline - b.baseline);
  let top = initial.y,
    end = bottom(initial);
  if (exercise)
    top = safeCut(ink, initial, 'y', Math.max(initial.y, exercise.y - 4), 28);
  else if (
    initialNumbers[0] &&
    initialNumbers[0].baseline > initial.y + initial.h * 0.35
  ) {
    const whitespace = gaps(
      projection(ink, initial, 'y'),
      initial.y,
      initialNumbers[0].y - 4,
      ink.scale,
    ).filter((gap) => gap.b - gap.a >= 10);
    whitespace.sort((a, b) => b.b - b.a - (a.b - a.a));
    if (whitespace[0]) top = (whitespace[0].a + whitespace[0].b) / 2;
  }
  const section = [
    ...initialRuns.filter(
      (run) =>
        run.y > top + 70 &&
        /^EXERCISES?\s+\d/i.test(run.text.trim()) &&
        spans.some(
          (span) =>
            span.baseline < run.baseline &&
            /^\d{1,3}[.)](?:\s|$)/.test(span.text.trim()),
        ),
    ),
    ...textLines(spans, initial).filter(
      (run) =>
        run.y > top + 70 &&
        /^\s*\d+\.\d+\s+[A-Z]/u.test(run.text) &&
        run.h >= 10,
    ),
    ...spans.filter(
      (span) =>
        span.y > top + 70 &&
        /^\d+\.\d+$/.test(span.text.trim()) &&
        span.h >= 14 &&
        spans.some(
          (title) =>
            title.x > right(span) &&
            title.x - right(span) < 40 &&
            Math.abs(title.baseline - span.baseline) < 3 &&
            title.h >= 12 &&
            /^[A-Z]/u.test(title.text.trim()),
        ),
    ),
  ].sort((a, b) => a.y - b.y)[0];
  if (section) {
    let wanted = Math.max(top + 20, section.y - 6);
    const scanTop = Math.max(top, section.y - 70) * ink.scale,
      scanBottom = section.y * ink.scale,
      x0 = Math.max(0, Math.floor(initial.x * ink.scale)),
      x1 = Math.min(ink.width, Math.ceil(right(initial) * ink.scale)),
      ruleWidth = initial.w * ink.scale * 0.35;
    for (
      let y = Math.floor(scanTop);
      y < Math.min(ink.height, scanBottom);
      y++
    ) {
      let run = 0,
        longest = 0;
      for (let x = x0; x < x1; x++) {
        if (ink.data[y * ink.width + x]) {
          run++;
          longest = Math.max(longest, run);
        } else run = 0;
      }
      if (longest >= ruleWidth) {
        wanted = y / ink.scale - 2;
        break;
      }
    }
    end = safeCut(
      ink,
      { ...initial, y: top, h: bottom(initial) - top },
      'y',
      wanted,
      wanted < section.y - 10 ? 10 : 36,
    );
  }
  const body = excludeSolidEdgeFill(
    ink,
    trim(ink, { ...initial, y: top, h: Math.max(20, end - top) }, 4),
  );
  // Reuse the stricter event anchor test. A bare number inside an equation is
  // not evidence for a second column; treating it as one shifts the divider
  // into the left column and turns ordinary rows into false full-width bands.
  const nums = events(spans, body).filter((event) => event.kind === 'problem');
  const xs = nums.map((event) => event.span.x).sort((a, b) => a - b);
  const left = xs[0] ?? body.x;
  const second = xs.find(
    (x) => x - left > width * 0.3 && x - left < width * 0.56,
  );
  const p = projection(ink, body, 'x');
  // Trimming can shorten one physical page edge when the selected exercise
  // ends near the top. The true gutter still follows the original page body,
  // so use that center when no second-column number anchor is available.
  const center =
    second !== undefined ? second - 7 : initial.x + initial.w / 2;
  const gs = gaps(
    p,
    Math.max(body.x + body.w * 0.3, center - width * 0.045),
    Math.min(right(body) - body.w * 0.2, center + width * 0.045),
    ink.scale,
    Math.max(2, Math.ceil(body.h * ink.scale * 0.012)),
  ).filter((g) => g.b - g.a >= 4);
  gs.sort((a, b) => b.b - b.a - (a.b - a.a));
  const divider =
    second !== undefined ? center : gs[0] ? (gs[0].a + gs[0].b) / 2 : undefined;
  if (divider === undefined)
    return { body, columns: [], regions: [{ ...body, columns: [] }] };

  // Full-width text runs and long rules identify bands that cross the gutter.
  // Ordinary two-column equations may touch the gutter by a glyph or two, so
  // center occupancy alone is intentionally not enough.
  const candidates = textRuns(spans, body)
    .filter((run) => {
      if (
        run.x >= divider - 14 ||
        right(run) <= divider + 14 ||
        run.w <= body.w * 0.55 ||
        divider - run.x <= body.w * 0.18 ||
        right(run) - divider <= body.w * 0.18
      )
        return false;
      const ordered = [...run.spans].sort((a, b) => a.x - b.x),
        crossing = ordered.some(
          (span) => span.x <= divider && right(span) >= divider,
        ),
        leftSpan = ordered.filter((span) => right(span) <= divider).at(-1),
        rightSpan = ordered.find((span) => span.x >= divider),
        bridge =
          leftSpan &&
          rightSpan &&
          rightSpan.x - right(leftSpan) <= Math.max(3.5, body.w * 0.007);
      return crossing || bridge;
    })
    .map((run) => ({
      a: Math.max(body.y, run.y - 3),
      b: Math.min(bottom(body), bottom(run) + 3),
    }));
  const exerciseHeader = textRuns(spans, body).find((run) =>
    /^Answers to selected (?:odd-numbered )?problems\b/i.test(run.text.trim()),
  );
  if (exerciseHeader)
    candidates.push({
      a: body.y,
      b: Math.min(bottom(body), bottom(exerciseHeader) + 8),
    });
  // Decorative horizontal rules may cross the gutter, but they do not change
  // the reading layout. Only actual text spanning both columns creates a
  // full-width band.
  candidates.sort((a, b) => a.a - b.a);
  const fullWidthBands: { a: number; b: number }[] = [];
  for (const candidate of candidates) {
    const previous = fullWidthBands.at(-1);
    if (previous && candidate.a - previous.b <= 10)
      previous.b = Math.max(previous.b, candidate.b);
    else fullWidthBands.push({ ...candidate });
  }

  const regions: LayoutRegion[] = [];
  let cursor = body.y;
  const push = (a: number, b: number, columns: number[]) => {
    if (b - a < 2) return;
    const previous = regions.at(-1);
    if (
      previous &&
      previous.columns.length === columns.length &&
      previous.columns.every((x, i) => Math.abs(x - columns[i]) < 0.1)
    ) {
      previous.h = b - previous.y;
      return;
    }
    regions.push({ x: body.x, y: a, w: body.w, h: b - a, columns });
  };
  for (const band of fullWidthBands) {
    const a = safeCut(ink, body, 'y', band.a, 7),
      b = safeCut(ink, body, 'y', band.b, 7);
    push(cursor, Math.max(cursor, a), [divider]);
    push(Math.max(cursor, a), Math.max(a + 2, b), []);
    cursor = Math.max(cursor, b);
  }
  push(cursor, bottom(body), [divider]);
  const useful = regions.filter((r) => r.h >= 4);
  if (!useful.length) useful.push({ ...body, columns: [divider] });
  const twoColumnHeight = useful
    .filter((r) => r.columns.length)
    .reduce((sum, r) => sum + r.h, 0);
  return {
    body,
    columns: twoColumnHeight >= body.h / 2 ? [divider] : [],
    regions: useful,
  };
}
type Event = {
  span: Span;
  kind: Block['kind'];
  label: string;
  range?: [number, number];
};
type TextRun = Rect & {
  baseline: number;
  text: string;
  font: string;
  spans: Span[];
};
function textRuns(spans: Span[], r: Rect): TextRun[] {
  const inside = spans
    .filter(
      (t) =>
        t.x >= r.x &&
        t.x < right(r) &&
        t.baseline >= r.y &&
        t.baseline < bottom(r),
    )
    .sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Span[][] = [];
  for (const span of inside) {
    const row = rows.findLast(
      (candidate) => Math.abs(candidate[0].baseline - span.baseline) < 3,
    );
    if (row) row.push(span);
    else rows.push([span]);
  }
  const runs: TextRun[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let group: Span[] = [];
    const flush = () => {
      if (!group.length) return;
      const x = Math.min(...group.map((s) => s.x)),
        y = Math.min(...group.map((s) => s.y)),
        end = Math.max(...group.map(right)),
        low = Math.max(...group.map(bottom));
      runs.push({
        x,
        y,
        w: end - x,
        h: low - y,
        baseline: group[0].baseline,
        text: group
          .map((s) => s.text.trim())
          .filter(Boolean)
          .join(' '),
        font: group.map((s) => s.font).join(' '),
        spans: group,
      });
      group = [];
    };
    for (const span of row) {
      const prior = group.at(-1);
      if (prior && span.x - right(prior) > Math.max(8, r.w * 0.015)) flush();
      group.push(span);
    }
    flush();
  }
  return runs;
}
function textLines(spans: Span[], r: Rect): TextRun[] {
  const inside = spans
    .filter(
      (t) =>
        t.x >= r.x &&
        t.x < right(r) &&
        t.baseline >= r.y &&
        t.baseline < bottom(r),
    )
    .sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rows: Span[][] = [];
  for (const span of inside) {
    const row = rows.findLast(
      (candidate) => Math.abs(candidate[0].baseline - span.baseline) < 3,
    );
    if (row) row.push(span);
    else rows.push([span]);
  }
  return rows.map((row) => {
    row = row
      .sort((a, b) => a.x - b.x)
      .filter(
        (span, index, sorted) =>
          !sorted
            .slice(0, index)
            .some(
              (prior) =>
                prior.text === span.text &&
                Math.abs(prior.x - span.x) < 0.5 &&
                Math.abs(prior.baseline - span.baseline) < 0.5,
            ),
      );
    const x = Math.min(...row.map((s) => s.x)),
      y = Math.min(...row.map((s) => s.y)),
      end = Math.max(...row.map(right)),
      low = Math.max(...row.map(bottom));
    let lineText = '',
      prior: Span | undefined;
    for (const span of row) {
      if (lineText && prior && span.x - right(prior) > 1.5) lineText += ' ';
      lineText += span.text.trim();
      prior = span;
    }
    return {
      x,
      y,
      w: end - x,
      h: low - y,
      baseline: row[0].baseline,
      text: lineText,
      font: row.map((s) => s.font).join(' '),
      spans: row,
    };
  });
}
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
    else if (
      /^(?:In\s+|Answer\s+)(?:Problems?|Exercises?)\s+\d/i.test(text) &&
      !inside.some(
        (s) =>
          s.x < t.x &&
          Math.abs(s.baseline - t.baseline) < 3 &&
          /^\d{1,3}[.)](?:\s|$)/.test(s.text.trim()),
      )
    ) {
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
      /^(?:Discussion Problems|Computer Lab Assignments|Exercises?\s*\d|Answers\b|Chapter\s+\d)/i.test(
        text,
      )
    )
      es.push({ span: t, kind: 'instruction', label: text });
  }
  for (const run of textRuns(inside, r)) {
    if (
      (/^EXERCISES?\b/.test(run.text.trim()) ||
        /^(?:Discussion Problems|Computer Lab Assignments)/i.test(run.text)) &&
      !es.some(
        (e) =>
          e.kind === 'instruction' &&
          Math.abs(e.span.baseline - run.baseline) < 3 &&
          Math.abs(e.span.x - run.x) < 3,
      )
    )
      es.push({
        span: { ...run, text: run.text },
        kind: 'instruction',
        label: run.text,
      });
  }
  for (const line of textLines(inside, r)) {
    const namedHeading = line.text.match(
      /^(EXERCISES?\b.*|Discussion\s+Problems\b.*|Computer\s+Lab\s+Assignments\b.*)$/i,
    )?.[1],
      subsection = line.text.match(
        /^(\d+\.\d+\.\d+)\s*([A-Z]|\p{Script=Hangul})(.*)$/u,
      ),
      heading =
        namedHeading ??
        (subsection
          ? `${subsection[1]} ${subsection[2]}${subsection[3]}`.trim()
          : undefined);
    if (
      heading &&
      !es.some(
        (e) =>
          e.kind === 'instruction' &&
          Math.abs(e.span.baseline - line.baseline) < 3,
      )
    )
      es.push({
        span: { ...line, text: heading },
        kind: 'instruction',
        label: heading,
      });
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
  const regions = info.regions?.filter((r) => r.h > 0) ?? [
    { ...info.body, columns: info.columns },
  ];
  for (const region of regions) {
    const bounds = [
      region.x,
      ...region.columns
        .filter((x) => x > region.x && x < right(region))
        .sort((a, b) => a - b),
      right(region),
    ];
    for (let c = 0; c < bounds.length - 1; c++) {
      const col = { ...region, x: bounds[c], w: bounds[c + 1] - bounds[c] };
      const es = events(info.spans, col);
      const make = (r: Rect, e?: Event, extra: string[] = []) => {
        const crop = trim(ink, r, 2);
        if (!projection(ink, crop, 'y').some((v) => v > 0)) return;
        const label =
          e &&
          /^Answers\b/i.test(e.label) &&
          region === regions[0] &&
          region.columns.length === 0
            ? '연습문제 머리말'
            : (e?.label ?? '이어짐 / 미분류');
        blocks.push({
          id: uid(),
          label,
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
          '단 또는 페이지 앞부분입니다. 이전 문제와 이어지는지 확인하세요',
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
  }
  return blocks;
}
export function linkContinuations(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const b = blocks[index];
    const prev = out.at(-1);
    const page = b.fragments[0]?.page;
    const nextProblem = blocks
      .slice(index + 1)
      .find(
        (candidate) =>
          candidate.fragments[0]?.page === page &&
          candidate.kind === 'problem' &&
          Number.isFinite(Number(candidate.label)),
      );
    const expectedPrevious = nextProblem
      ? String(Number(nextProblem.label) - 1)
      : undefined;
    const numberedTarget = expectedPrevious
      ? out.findLast(
          (candidate) =>
            candidate.kind === 'problem' &&
            candidate.label === expectedPrevious,
        )
      : undefined;
    const nextNumber = Number(nextProblem?.label);
    const rangedInstruction =
      prev?.kind === 'instruction' &&
      prev.range &&
      Number.isFinite(nextNumber) &&
      nextNumber >= prev.range[0] &&
      nextNumber <= prev.range[1]
        ? prev
        : undefined;
    const target = rangedInstruction ?? numberedTarget ?? prev;
    if (
      b.kind === 'unassigned' &&
      target &&
      (target.kind === 'problem' ||
        (target.kind === 'instruction' && !!target.range)) &&
      b.warnings.some((w) => w.includes('앞부분'))
    ) {
      const targetIndex = out.findLastIndex((candidate) => candidate === target);
      out[targetIndex] = {
        ...target,
        fragments: [...target.fragments, ...b.fragments],
        reviewed: false,
        warnings: [
          ...target.warnings,
          `${target.kind === 'instruction' ? '공통 지시문' : '문제'}의 이어지는 조각을 임시 연결했습니다. 연결이 맞는지 확인하세요`,
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
  const groups: number[][] = [];
  for (const number of numbers) {
    const group = groups.at(-1);
    if (!group || number < group.at(-1)!) groups.push([number]);
    else group.push(number);
  }
  const duplicates = groups.flatMap((group) =>
    group.filter((n, i) => group.indexOf(n) !== i),
  );
  const missing: number[] = [];
  for (const group of groups) {
    for (
      let n = Math.min(...group);
      n <= Math.max(...group) && missing.length < 100;
      n++
    )
      if (!group.includes(n)) missing.push(n);
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
  const regions = info.regions?.length
      ? info.regions
      : [{ ...info.body, columns: info.columns }],
    out: Rect[] = [];
  for (const region of regions) {
    const bounds = [region.x, ...region.columns, right(region)];
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
            y: Math.max(region.y, minY / s - 1),
            w:
              Math.min(bounds[c + 1], (maxX + 1) / s + 1) -
              Math.max(bounds[c], minX / s - 1),
            h:
              Math.min(bottom(region), (maxY + 1) / s + 1) -
              Math.max(region.y, minY / s - 1),
          });
        minX = width;
        maxX = 0;
        minY = -1;
        count = 0;
      };
      for (
        let y = Math.floor(region.y * s);
        y < Math.min(height, Math.ceil(bottom(region) * s));
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
  }
  return out;
}
