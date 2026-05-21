"use client";

import { useEffect } from "react";

/**
 * Glass modal: backdrop + centered card. Closes on Escape and backdrop click.
 * Pass `danger` to tint the card border warm-coral (used for dispute / rejection flows).
 */
export function Modal({
  title,
  onClose,
  danger = false,
  children,
}: {
  title: string;
  onClose: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`modal-card${danger ? " danger" : ""}`}>
        <div className="modal-head">
          <h2 className={danger ? "danger" : undefined}>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
