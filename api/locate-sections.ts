const allowedOrigins = new Set([
  'https://problembook-cutter.vercel.app',
  'https://problembook-cutter-exelenta.hyeonjune-jang.chatgpt.site',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function responseHeaders(request: Request) {
  const origin = request.headers.get('origin');
  const result: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
  if (origin && allowedOrigins.has(origin)) {
    result['Access-Control-Allow-Origin'] = origin;
    result.Vary = 'Origin';
  }
  return result;
}

function json(request: Request, body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders(request) });
}

function outputText(response: Record<string, unknown>) {
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
      )
        return (part as { text: string }).text;
    }
  }
  throw new Error('AI 응답에서 범위 정보를 읽지 못했습니다.');
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}

export async function POST(requestObject: Request) {
  const origin = requestObject.headers.get('origin');
  if (origin && !allowedOrigins.has(origin))
    return json(requestObject, { error: '허용되지 않은 사이트입니다.' }, 403);
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    return json(
      requestObject,
      { error: '서버에 OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' },
      503,
    );

  let raw: unknown;
  try {
    raw = await requestObject.json();
  } catch {
    return json(requestObject, { error: '요청 형식이 올바르지 않습니다.' }, 400);
  }
  const body = (raw ?? {}) as {
    request?: unknown;
    pageCount?: unknown;
    pages?: unknown;
  };
  const userRequest =
    typeof body.request === 'string' ? body.request.trim() : '';
  const pageCount = Number(body.pageCount);
  const pages = Array.isArray(body.pages)
    ? body.pages
        .slice(0, 48)
        .map((page) => {
          const item = page as { page?: unknown; text?: unknown };
          return {
            page: Number(item.page),
            text: typeof item.text === 'string' ? item.text.slice(0, 1400) : '',
          };
        })
        .filter(
          (page) =>
            Number.isInteger(page.page) && page.page >= 1 && page.text.trim(),
        )
    : [];
  if (!userRequest || userRequest.length > 500)
    return json(
      requestObject,
      { error: '찾을 연습문제를 500자 이내로 입력하세요.' },
      400,
    );
  if (!Number.isInteger(pageCount) || pageCount < 1 || pages.length === 0)
    return json(
      requestObject,
      { error: 'PDF 페이지 텍스트가 비어 있습니다.' },
      400,
    );

  const instructions = `You locate exercise sections in textbook PDFs. The user may write Korean or English and may request several sections at once, such as "4.1, 4.2, 4.3, 4.4 연습문제 전부". The browser has already selected a small set of likely pages locally to control cost; missing page numbers between supplied candidates still exist in the PDF and may belong inside a continuous output range. Infer intended headings despite OCR errors, punctuation, spacing, translations, or headings such as EXERCISES 4.1, Review Exercises, Chapter Review, 연습문제, 문제, 탐구 문제. Return PDF page indexes, never printed page numbers. A range must include every page containing the requested exercise problems, including intermediate pages not supplied when the start and next-section evidence establish them. Do not include a table of contents occurrence. Use problem-number sequences and neighboring page continuity as evidence. Return one range per requested section; merge only if the PDF makes adjacent sections genuinely inseparable. If uncertain, prefer a slightly wider range and explain briefly in Korean.`;
  const input = `사용자 요청: ${userRequest}\nPDF 전체 페이지 수: ${pageCount}\n로컬 검색으로 추린 후보 ${pages.length}페이지의 발췌 텍스트입니다.\n${pages
    .map((page) => `\n--- PDF PAGE ${page.page} ---\n${page.text}`)
    .join('')}`;

  try {
    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
        store: false,
        reasoning: { effort: 'low' },
        instructions,
        input,
        text: {
          format: {
            type: 'json_schema',
            name: 'exercise_ranges',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                normalized_request: { type: 'string' },
                ranges: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      label: { type: 'string' },
                      start: { type: 'integer' },
                      end: { type: 'integer' },
                      confidence: { type: 'number' },
                      reason: { type: 'string' },
                    },
                    required: ['label', 'start', 'end', 'confidence', 'reason'],
                  },
                },
              },
              required: ['normalized_request', 'ranges'],
            },
          },
        },
      }),
    });
    const data = (await openaiResponse.json()) as Record<string, unknown>;
    if (!openaiResponse.ok) {
      const detail = data.error as { message?: string } | undefined;
      const apiMessage = detail?.message || `OpenAI API 오류 (${openaiResponse.status})`;
      throw new Error(
        /context window|maximum context|too many tokens/i.test(apiMessage)
          ? 'AI 입력 한도를 넘었습니다. 더 적은 절로 나누어 검색해 주세요.'
          : apiMessage,
      );
    }
    return json(requestObject, JSON.parse(outputText(data)));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'AI 범위 검색에 실패했습니다.';
    return json(requestObject, { error: message }, 502);
  }
}
