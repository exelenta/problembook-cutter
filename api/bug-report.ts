const allowedOrigins = new Set([
  'https://problembook-cutter.vercel.app',
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

function safeFilename(value: string) {
  return (
    value
      .split('')
      .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'source.pdf'
  );
}

function decodeAttachment(content: unknown, limit: number) {
  if (
    typeof content !== 'string' ||
    content.length < 8 ||
    content.length > limit ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
  )
    return undefined;
  return Buffer.from(content, 'base64');
}

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: responseHeaders(request) });
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins.has(origin))
    return json(request, { error: '허용되지 않은 사이트입니다.' }, 403);

  const apiKey = process.env.RESEND_API_KEY?.trim(),
    recipient = process.env.BUG_REPORT_EMAIL?.trim(),
    sender =
      process.env.BUG_REPORT_FROM?.trim() ||
      'Problembook Cutter <onboarding@resend.dev>';
  if (!apiKey || !recipient)
    return json(
      request,
      {
        error:
          '서버에 RESEND_API_KEY와 BUG_REPORT_EMAIL 환경변수를 설정해 주세요.',
      },
      503,
    );

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(request, { error: '제보 요청 형식이 올바르지 않습니다.' }, 400);
  }
  const body = (raw ?? {}) as {
    reportId?: unknown;
    filename?: unknown;
    page?: unknown;
    pageCount?: unknown;
    fingerprint?: unknown;
    sourcePage?: unknown;
    overlay?: unknown;
    result?: unknown;
  };
  const reportId = typeof body.reportId === 'string' ? body.reportId : '',
    filename =
      typeof body.filename === 'string'
        ? safeFilename(body.filename)
        : 'source.pdf',
    page = Number(body.page),
    pageCount = Number(body.pageCount),
    fingerprint =
      typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 64) : '',
    sourcePage = decodeAttachment(body.sourcePage, 3_500_000),
    overlay = decodeAttachment(body.overlay, 1_500_000);
  if (
    !/^[0-9a-f-]{20,64}$/i.test(reportId) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageCount) ||
    pageCount < page ||
    !sourcePage ||
    sourcePage.subarray(0, 5).toString() !== '%PDF-'
  )
    return json(request, { error: '제보에 필요한 현재 페이지 정보가 없습니다.' }, 400);
  if (sourcePage.toString('base64').length + (typeof body.overlay === 'string' ? body.overlay.length : 0) > 3_900_000)
    return json(request, { error: '제보 첨부 파일이 너무 큽니다.' }, 413);

  let resultText: string;
  try {
    resultText = JSON.stringify(body.result, null, 2);
  } catch {
    return json(request, { error: '경계 결과를 읽지 못했습니다.' }, 400);
  }
  if (!resultText || resultText.length > 250_000)
    return json(request, { error: '경계 결과가 너무 큽니다.' }, 413);

  const attachments = [
    {
      filename: `${filename.replace(/\.pdf$/i, '')}-page-${page}.pdf`,
      content: sourcePage.toString('base64'),
    },
    {
      filename: `boundary-result-page-${page}.json`,
      content: Buffer.from(resultText).toString('base64'),
    },
  ];
  if (overlay?.length)
    attachments.push({
      filename: `boundary-result-page-${page}.jpg`,
      content: overlay.toString('base64'),
    });

  let mail: Response;
  try {
    mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `bug-report/${reportId}`,
      },
      body: JSON.stringify({
        from: sender,
        to: [recipient],
        subject: `[Problembook Cutter] ${filename} · PDF ${page}페이지 버그 제보`,
        text: [
          'Problembook Cutter에서 경계 검출 버그가 제보되었습니다.',
          '',
          `파일: ${filename}`,
          `PDF 페이지: ${page} / ${pageCount}`,
          `PDF 지문: ${fingerprint || '(없음)'}`,
          `제보 시각: ${new Date().toISOString()}`,
          '',
          '첨부: 원본 한 페이지 PDF, 경계 결과 JSON, 경계 오버레이 이미지(생성 가능한 경우)',
        ].join('\n'),
        attachments,
      }),
    });
  } catch {
    return json(request, { error: '메일 서비스에 연결하지 못했습니다.' }, 502);
  }
  const response = (await mail.json().catch(() => ({}))) as {
    id?: unknown;
    message?: unknown;
    error?: { message?: unknown };
  };
  if (!mail.ok) {
    const detail =
      typeof response.error?.message === 'string'
        ? response.error.message
        : typeof response.message === 'string'
          ? response.message
          : `메일 전송 오류 (${mail.status})`;
    return json(request, { error: detail }, 502);
  }
  return json(request, { ok: true, id: response.id });
}
