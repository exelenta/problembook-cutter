/* oxlint-disable next/no-img-element -- Source image is a local blob; never send it to an optimization server. */
'use client';
import { useRef, useState } from 'react';
import {
  type Block,
  type Fragment,
  type Rect,
  bottom,
  right,
} from '@/lib/model';
import type { Rendered } from '@/lib/pdf-client';
type Props = {
  rendered: Rendered;
  blocks: Block[];
  active?: string;
  fragment?: string;
  mode: 'select' | 'add' | 'append' | 'split';
  guides: boolean;
  onSelect: (b: string, f: string) => void;
  onRect: (b: string, f: string, r: Rect) => void;
  onAdd: (r: Rect) => void;
  onSplit: (f: string, y: number) => void;
};
export function CropEditor({
  rendered,
  blocks,
  active,
  fragment,
  mode,
  guides,
  onSelect,
  onRect,
  onAdd,
  onSplit,
}: Props) {
  const svg = useRef<SVGSVGElement>(null),
    drag = useRef<
      | {
          start: { x: number; y: number };
          rect: Rect;
          block?: string;
          fragment?: string;
          handle: string;
        }
      | undefined
    >(undefined);
  const [ghost, setGhost] = useState<Rect>();
  const [dragId, setDragId] = useState<string>();
  const { info, url } = rendered;
  function point(e: React.PointerEvent) {
    const p = svg.current!.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const t = p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return {
      x: Math.max(0, Math.min(info.width, t.x)),
      y: Math.max(0, Math.min(info.height, t.y)),
    };
  }
  function start(
    e: React.PointerEvent,
    handle: string,
    b?: Block,
    f?: Fragment,
  ) {
    e.stopPropagation();
    e.preventDefault();
    const p = point(e);
    if (mode === 'split' && f) {
      onSplit(f.id, p.y);
      return;
    }
    if (b && f) onSelect(b.id, f.id);
    setDragId(f?.id ?? 'new');
    drag.current = {
      start: p,
      rect: f?.rect ?? { x: p.x, y: p.y, w: 0, h: 0 },
      block: b?.id,
      fragment: f?.id,
      handle,
    };
    svg.current?.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = point(e),
      dx = p.x - d.start.x,
      dy = p.y - d.start.y,
      r = { ...d.rect };
    if (d.handle === 'new') {
      r.x = Math.min(d.start.x, p.x);
      r.y = Math.min(d.start.y, p.y);
      r.w = Math.abs(dx);
      r.h = Math.abs(dy);
    } else if (d.handle === 'move') {
      r.x = Math.max(0, Math.min(info.width - r.w, r.x + dx));
      r.y = Math.max(0, Math.min(info.height - r.h, r.y + dy));
    } else {
      if (d.handle.includes('w')) {
        r.x = Math.min(right(d.rect) - 2, p.x);
        r.w = right(d.rect) - r.x;
      }
      if (d.handle.includes('e')) r.w = Math.max(2, p.x - r.x);
      if (d.handle.includes('n')) {
        r.y = Math.min(bottom(d.rect) - 2, p.y);
        r.h = bottom(d.rect) - r.y;
      }
      if (d.handle.includes('s')) r.h = Math.max(2, p.y - r.y);
    }
    setGhost(r);
  }
  function end(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (ghost && ghost.w >= 2 && ghost.h >= 2) {
      if (d.block && d.fragment) onRect(d.block, d.fragment, ghost);
      else onAdd(ghost);
    }
    drag.current = undefined;
    setGhost(undefined);
    if (svg.current?.hasPointerCapture(e.pointerId))
      svg.current.releasePointerCapture(e.pointerId);
  }
  return (
    <div className="source-sheet">
      <img src={url} alt={`원본 PDF ${info.page}페이지`} draggable={false} />
      <svg
        ref={svg}
        viewBox={`0 0 ${info.width} ${info.height}`}
        className={`crop-overlay mode-${mode}`}
        onPointerDown={(e) => {
          if (mode === 'add' || mode === 'append') start(e, 'new');
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          drag.current = undefined;
          setGhost(undefined);
        }}
      >
        <title>
          문제 영역 편집. 영역을 선택하고 모서리를 드래그하세요. 숫자 입력으로도
          조정할 수 있습니다.
        </title>
        {guides && (
          <g pointerEvents="none" className="guides">
            <rect
              x={info.body.x}
              y={info.body.y}
              width={info.body.w}
              height={info.body.h}
            />
            {(info.regions?.length
              ? info.regions
              : [{ ...info.body, columns: info.columns }]
            ).map((region, i) => (
              <g key={`${region.y}-${i}`}>
                {i > 0 && (
                  <line
                    x1={region.x}
                    x2={right(region)}
                    y1={region.y}
                    y2={region.y}
                  />
                )}
                {region.columns.map((x) => (
                  <line
                    key={x}
                    x1={x}
                    x2={x}
                    y1={region.y}
                    y2={bottom(region)}
                  />
                ))}
              </g>
            ))}
          </g>
        )}
        {/* oxlint-disable-next-line react/react-compiler -- Pointer handlers read refs only on events, never while constructing the SVG. */}
        {blocks.flatMap((b) =>
          b.fragments
            .filter((f) => f.page === info.page)
            .map((f) => {
              const r = dragId === f.id && ghost ? ghost : f.rect,
                isActive = active === b.id,
                isFragment = fragment === f.id;
              return (
                <g
                  key={f.id}
                  className={`crop ${b.kind} ${b.selected ? '' : 'excluded'} ${b.reviewed || b.reviewedPages?.includes(f.page) ? 'reviewed' : ''} ${isActive ? 'active' : ''}`}
                  style={{
                    pointerEvents:
                      mode === 'add' || mode === 'append' ? 'none' : undefined,
                  }}
                >
                  <rect
                    x={r.x}
                    y={r.y}
                    width={r.w}
                    height={r.h}
                    onPointerDown={(e) => start(e, 'move', b, f)}
                  />
                  <text
                    x={r.x + 2}
                    y={r.y - 3}
                    fontSize={7}
                    pointerEvents="none"
                  >
                    {b.kind === 'problem'
                      ? `#${b.label}`
                      : b.label.slice(0, 22)}
                    {b.fragments.length > 1 ? ' ↔' : ''}
                  </text>
                  {isActive &&
                    isFragment &&
                    mode === 'select' &&
                    (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                      <rect
                        key={h}
                        className="handle"
                        x={(h.includes('w') ? r.x : right(r)) - 3}
                        y={(h.includes('n') ? r.y : bottom(r)) - 3}
                        width={6}
                        height={6}
                        style={{ cursor: `${h}-resize` }}
                        onPointerDown={(e) => start(e, h, b, f)}
                      />
                    ))}
                </g>
              );
            }),
        )}
        {ghost && dragId === 'new' && (
          <rect
            className="ghost"
            x={ghost.x}
            y={ghost.y}
            width={ghost.w}
            height={ghost.h}
          />
        )}
      </svg>
    </div>
  );
}
