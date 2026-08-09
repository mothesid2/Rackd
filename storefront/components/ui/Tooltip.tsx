'use client';
import { useRef, useState, useCallback, type ReactNode } from 'react';

/**
 * Wraps a single icon-only control and shows a text label on hover/focus
 * (desktop) or tap-and-hold (touch). Mirrors the vanilla RackdUI.tooltip
 * behavior in shared-ui/kit.js so the fleet's icon-only controls behave the
 * same way everywhere: 400ms hover delay (inside the 300-500ms band, avoids
 * flashing on a quick pointer pass), immediate on keyboard focus, viewport
 * clamped so it never renders off-screen.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchMoved = useRef(false);

  const place = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    // Bubble width isn't known until it renders; estimate then let CSS
    // max-width + the clamp below keep it on-screen either way.
    const estWidth = Math.min(220, label.length * 6.5 + 20);
    let side: 'top' | 'bottom' = 'top';
    let top = r.top - 34;
    if (top < pad) { side = 'bottom'; top = r.bottom + 8; }
    let left = r.left + r.width / 2 - estWidth / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - estWidth - pad));
    setPos({ left, top, side });
    setVisible(true);
  }, [label]);

  function hide() {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    setVisible(false);
  }

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={() => { showTimer.current = setTimeout(place, 400); }}
      onMouseLeave={hide}
      onFocus={place}
      onBlur={hide}
      onTouchStart={() => {
        touchMoved.current = false;
        holdTimer.current = setTimeout(() => { if (!touchMoved.current) place(); }, 450);
      }}
      onTouchMove={() => { touchMoved.current = true; if (holdTimer.current) clearTimeout(holdTimer.current); }}
      onTouchEnd={() => { if (holdTimer.current) clearTimeout(holdTimer.current); setTimeout(hide, 1200); }}
    >
      {children}
      {visible && pos && (
        <span
          role="tooltip"
          className="fixed z-[9999] pointer-events-none bg-[#1b1d21] text-white text-xs font-medium leading-tight px-2.5 py-1.5 rounded-md shadow-lg max-w-[220px]"
          style={{ left: pos.left, top: pos.top }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
