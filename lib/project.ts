import { validRect, type Block, type PageInfo, type Settings } from './model';
export type SavedProject = {
  version: 1;
  fingerprint: string;
  filename: string;
  blocks: Block[];
  pages: Pick<
    PageInfo,
    'page' | 'width' | 'height' | 'body' | 'columns' | 'regions'
  >[];
  settings: Settings;
};
export function validateProject(
  value: unknown,
  hash: string,
  pageCount: number,
): SavedProject {
  const p = value as SavedProject;
  if (!p || p.version !== 1 || p.fingerprint !== hash)
    throw new Error(
      '이 프로젝트에 사용한 원본 PDF를 먼저 열어 주세요. 파일이 일치하지 않습니다.',
    );
  if (
    !Array.isArray(p.pages) ||
    !Array.isArray(p.blocks) ||
    p.blocks.length > 10000 ||
    !p.settings
  )
    throw new Error('프로젝트 형식이 올바르지 않습니다.');
  const ids = new Set<string>(),
    fragments = new Set<string>();
  for (const page of p.pages)
    if (
      !Number.isInteger(page.page) ||
      page.page < 1 ||
      page.page > pageCount ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      !validRect(page.body, page.width, page.height) ||
      !Array.isArray(page.columns) ||
      page.columns.some(
        (x) =>
          !Number.isFinite(x) ||
          x <= page.body.x ||
          x >= page.body.x + page.body.w,
      ) ||
      (page.regions !== undefined &&
        (!Array.isArray(page.regions) ||
          !page.regions.length ||
          page.regions.some(
            (region) =>
              !validRect(region, page.width, page.height) ||
              !Array.isArray(region.columns) ||
              region.columns.some(
                (x) =>
                  !Number.isFinite(x) ||
                  x <= region.x ||
                  x >= region.x + region.w,
              ),
          )))
    )
      throw new Error('페이지 설정이 올바르지 않습니다.');
  for (const b of p.blocks) {
    if (
      typeof b.id !== 'string' ||
      ids.has(b.id) ||
      !['problem', 'instruction', 'unassigned'].includes(b.kind) ||
      typeof b.label !== 'string' ||
      typeof b.selected !== 'boolean' ||
      typeof b.reviewed !== 'boolean' ||
      (b.reviewedPages !== undefined &&
        (!Array.isArray(b.reviewedPages) ||
          b.reviewedPages.some(
            (page) => !Number.isInteger(page) || page < 1 || page > pageCount,
          ))) ||
      !Array.isArray(b.warnings) ||
      b.warnings.some((w) => typeof w !== 'string') ||
      !Array.isArray(b.fragments) ||
      !b.fragments.length
    )
      throw new Error('문제 블록 정보가 올바르지 않습니다.');
    ids.add(b.id);
    if (
      b.range &&
      (!Array.isArray(b.range) ||
        b.range.length !== 2 ||
        !b.range.every(Number.isFinite) ||
        b.range[0] > b.range[1])
    )
      throw new Error('공통 지시문 범위가 올바르지 않습니다.');
    for (const f of b.fragments) {
      const page = p.pages.find((s) => s.page === f.page);
      if (
        typeof f.id !== 'string' ||
        fragments.has(f.id) ||
        !page ||
        !validRect(f.rect, page.width, page.height)
      )
        throw new Error('잘라낼 영역 좌표가 올바르지 않습니다.');
      fragments.add(f.id);
    }
  }
  const s = p.settings;
  if (
    ![1, 2].includes(s.columns) ||
    !Number.isFinite(s.answerMm) ||
    s.answerMm < 0 ||
    s.answerMm > 150 ||
    typeof s.ruled !== 'boolean' ||
    typeof s.repeatInstructions !== 'boolean' ||
    (s.excludeHeaders !== undefined && typeof s.excludeHeaders !== 'boolean') ||
    typeof s.title !== 'string'
  )
    throw new Error('출력 설정이 올바르지 않습니다.');
  return {
    ...p,
    settings: {
      ...p.settings,
      excludeHeaders: p.settings.excludeHeaders ?? true,
    },
  };
}
