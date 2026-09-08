export type SectionRange = {
  label: string;
  start: number;
  end: number;
  confidence?: number;
  reason?: string;
};

export function parsePageRanges(value: string, pageCount: number) {
  const source = value.trim();
  if (!source) throw new Error('분석할 PDF 페이지 구간을 입력하세요.');
  const pages = new Set<number>();
  for (const raw of source.split(/[,;，]+/)) {
    const token = raw.trim();
    const match = token.match(/^(\d+)\s*(?:-|–|—|~|〜)\s*(\d+)$/);
    const single = token.match(/^\d+$/);
    if (!match && !single)
      throw new Error(`페이지 구간 “${token}”을 확인하세요. 예: 23-26, 29-30`);
    const start = Number(match?.[1] ?? token);
    const end = Number(match?.[2] ?? token);
    if (start < 1 || end < start || end > pageCount)
      throw new Error(`PDF는 1-${pageCount}페이지입니다. “${token}”을 확인하세요.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function formatPageRanges(pages: number[]) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[++i];
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return ranges.join(', ');
}

export function validateSectionRanges(
  ranges: SectionRange[],
  pageCount: number,
) {
  return ranges
    .filter(
      (range) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 1 &&
        range.end >= range.start &&
        range.end <= pageCount,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
