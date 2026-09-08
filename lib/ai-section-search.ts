export type TextPage = { page: number; text: string };

export function extractSectionIds(request: string) {
  return [
    ...new Set(
      [...request.normalize('NFKC').matchAll(/\d+(?:\s*[.-]\s*\d+)+/g)].map(
        (match) => match[0].replace(/\s+/g, '').replace(/-/g, '.'),
      ),
    ),
  ];
}

function nextSection(id: string) {
  const parts = id.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part))) return undefined;
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function compact(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function scoreForId(text: string, id: string) {
  const normalized = compact(text);
  const plain = id.replaceAll('.', '');
  const exercise = /exercises?|review\s*exercises?|연습\s*문제|연습문제/i.test(
    text,
  );
  const exactHeading =
    normalized.includes(`exercises${id}`) ||
    normalized.includes(`exercise${id}`) ||
    normalized.includes(`${id}exercises`) ||
    normalized.includes(`${id}exercise`) ||
    normalized.includes(`${id}연습문제`) ||
    normalized.includes(`연습문제${id}`);
  const hasId = normalized.includes(id) || normalized.includes(plain);
  const numberedProblems = (text.match(/(?:^|\s)\d{1,3}[.)]\s/g) ?? []).length;
  return (
    (exactHeading ? 30 : 0) +
    (hasId ? 8 : 0) +
    (exercise ? 5 : 0) +
    Math.min(numberedProblems, 5)
  );
}

function lexicalScore(text: string, request: string) {
  const haystack = compact(text);
  const tokens = request
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
  const overlap = tokens.filter((token) => haystack.includes(token)).length;
  const exercise = /exercises?|review|연습\s*문제|문제/i.test(text) ? 4 : 0;
  const numberedProblems = (text.match(/(?:^|\s)\d{1,3}[.)]\s/g) ?? []).length;
  return overlap * 5 + exercise + Math.min(numberedProblems, 4);
}

/** Select a small, locally discovered evidence set before any paid AI call. */
export function selectCandidatePages(
  request: string,
  pages: TextPage[],
  maxPages = 40,
) {
  if (pages.length <= maxPages) return pages;
  const ids = extractSectionIds(request);
  const evidenceIds = [...ids];
  const following = ids.length ? nextSection(ids[ids.length - 1]) : undefined;
  if (following) evidenceIds.push(following);

  const anchors = new Set<number>();
  if (evidenceIds.length) {
    for (const id of evidenceIds) {
      pages
        .map((page, index) => ({ index, score: scoreForId(page.text, id) }))
        .filter((item) => item.score >= 8)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 5)
        .forEach((item) => anchors.add(item.index));
    }
  }
  if (!anchors.size) {
    pages
      .map((page, index) => ({
        index,
        score: lexicalScore(page.text, request),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 16)
      .forEach((item) => anchors.add(item.index));
  }

  const selected = new Set<number>();
  for (const anchor of anchors) {
    for (let offset = -2; offset <= 2; offset++) {
      const index = anchor + offset;
      if (index >= 0 && index < pages.length) selected.add(index);
    }
  }
  const ranked = [...selected]
    .map((index) => ({
      index,
      score: evidenceIds.length
        ? Math.max(...evidenceIds.map((id) => scoreForId(pages[index].text, id)))
        : lexicalScore(pages[index].text, request),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxPages)
    .map((item) => item.index)
    .sort((a, b) => a - b);
  return ranked.map((index) => pages[index]);
}
