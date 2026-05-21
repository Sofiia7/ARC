"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Glass dropdown that matches the design system. Behaves like a native
 * <select> for our purposes — controlled value + onChange callback.
 *
 * Closes on outside click and Escape.
 */
export function GlassSelect<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly T[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={`select-wrap${open ? " open" : ""}`}
      data-value={value}
    >
      <button
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(o => !o)}
      >
        <span className="select-value" style={{ textTransform: "capitalize" }}>{value}</span>
        <svg
          className="select-chev"
          viewBox="0 0 12 8"
          width={11}
          height={7}
          aria-hidden="true"
        >
          <path
            d="M1 1l5 5 5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div className="select-menu" role="listbox">
        {options.map(opt => (
          <button
            key={opt}
            type="button"
            role="option"
            aria-selected={opt === value}
            className={`select-option${opt === value ? " selected" : ""}`}
            onClick={() => { onChange(opt); setOpen(false); }}
            style={{ textTransform: "capitalize" }}
          >
            {opt}
            <span className="check-glyph">✓</span>
          </button>
        ))}
      </div>
    </div>
  );
}
