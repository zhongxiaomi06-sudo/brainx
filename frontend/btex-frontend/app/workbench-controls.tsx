import type React from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { DirectSegmentOption } from "./workbench-model";

export function Heading({ code, title, desc, action }: { code: string; title: React.ReactNode; desc: string; action?: React.ReactNode }) {
  return (
    <div className="headline">
      <div>
        <span className="eyebrow">{code}</span>
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
      {action}
    </div>
  );
}
export function StatusTag({ s }: { s: string }) {
  const cls = s.includes("关闭") || s.includes("风险") || s.includes("异常") ? "red" : s === "拥挤" || s === "降温" ? "gray" : "blue";
  return <span className={`tag ${cls}`}>{s}</span>;
}

export function DrawerSection({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="drawer-section">
      <div className="drawer-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export type FilterSelectOption = { value: string; label: string };
export function FilterSelect({ value, options, onChange, ariaLabel }: { value: string; options: readonly FilterSelectOption[]; onChange: (value: string) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`filter-select${open ? " is-open" : ""}`} ref={root}>
      <button
        type="button"
        className="field filter-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected.label}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="filter-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "selected" : ""}
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DirectGlassSegment<T extends string>({ value, options, onChange, className = "", ariaLabel }: { value: T; options: readonly DirectSegmentOption<T>[]; onChange: (value: T) => void; className?: string; ariaLabel: string }) {
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startIndex: number; trackWidth: number; lastX: number; lastAt: number; velocity: number; progress: number; moved: boolean } | null>(null);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const progress = dragProgress ?? index;
  // The active glass must never escape the track.  A rubber-band transform looks
  // playful in isolation, but exposes a detached pane at either edge in a toolbar.
  const rubberBand = (raw: number) => Math.min(options.length - 1, Math.max(0, raw));
  const start = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startIndex: index, trackWidth: Math.max(1, rect.width - 8), lastX: event.clientX, lastAt: event.timeStamp, velocity: 0, progress: index, moved: false };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const distance = Math.abs(event.clientX - active.startX);
    if (!active.moved && distance < 8) return;
    if (!active.moved) {
      active.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const raw = active.startIndex + (event.clientX - active.startX) / (active.trackWidth / options.length);
    const elapsed = event.timeStamp - active.lastAt;
    if (elapsed > 0) active.velocity = (event.clientX - active.lastX) / elapsed;
    active.lastX = event.clientX;
    active.lastAt = event.timeStamp;
    active.progress = rubberBand(raw);
    setDragProgress(active.progress);
  };
  const finish = (event: React.PointerEvent<HTMLElement>, cancelled = false) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && active.moved) {
      const velocityInSteps = active.velocity / (active.trackWidth / options.length);
      const projected = Math.min(options.length - 1, Math.max(0, active.progress + Math.max(-0.5, Math.min(0.5, velocityInSteps * 140))));
      onChange(options[Math.round(projected)].value);
    }
    drag.current = null;
    setDragProgress(null);
  };
  return (
    <nav
      className={`direct-segment ${className}${dragProgress !== null ? " is-dragging" : ""}`}
      aria-label={ariaLabel}
      style={{ "--direct-index": progress, "--direct-count": options.length } as React.CSSProperties}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
    >
      <span className="direct-segment-lens" aria-hidden="true" />
      {options.map((option) => (
        <button key={option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)} aria-label={option.ariaLabel}>
          {option.label}
        </button>
      ))}
    </nav>
  );
}
