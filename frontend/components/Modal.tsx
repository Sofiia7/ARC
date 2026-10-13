"use client";

import { useEffect, useId, useRef, useState } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Glass modal: backdrop + centered card. Closes on Escape and backdrop click.
 * Pass `danger` to tint the card border warm-coral (used for dispute / rejection flows).
 *
 * Accessible dialog: role="dialog" + aria-modal, labelled by the title, focus
 * moves into the card on open (unless a field inside already took it with
 * autoFocus), Tab is trapped inside, and focus goes back to whatever opened it
 * on close.
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
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  // Captured while rendering, before any child with autoFocus can take focus.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) card.focus({ preventScroll: true });
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const card = cardRef.current;
    if (!card) return;
    const nodes = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(n => n.getClientRects().length > 0);
    if (nodes.length === 0) {
      e.preventDefault();
      card.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && card.contains(active);
    if (e.shiftKey && (!inside || active === first || active === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={cardRef}
        className={`modal-card${danger ? " danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ outline: "none" }}
        onKeyDown={trapTab}
      >
        <div className="modal-head">
          <h2 id={titleId} className={danger ? "danger" : undefined}>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
