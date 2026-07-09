"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMyActivity, ACTIVITY_LABELS } from "@/hooks/useMyActivity";

export function NotificationBell() {
  const { items, unreadCount, markAllRead } = useMyActivity();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function toggle() {
    setOpen(o => {
      const next = !o;
      if (next) markAllRead();
      return next;
    });
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={toggle}
        className="btn"
        title="Activity on your bounties"
        style={{ position: "relative", padding: "8px 12px", fontSize: 15 }}
      >
        🔔
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute", top: -4, right: -4,
              background: "#ff6b5e", color: "#fff",
              borderRadius: 999, fontSize: 10, fontWeight: 700,
              minWidth: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center",
              padding: "0 4px", lineHeight: 1,
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", right: 0, top: "calc(100% + 8px)",
            width: 320, maxHeight: 380, overflowY: "auto",
            background: "var(--g-bg)", border: "1px solid var(--g-border)",
            borderRadius: 14, backdropFilter: "var(--g-blur)", WebkitBackdropFilter: "var(--g-blur)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)", zIndex: 50, padding: 6,
          }}
        >
          {items.length === 0 ? (
            <div style={{ padding: 18, fontSize: 13, color: "var(--ink-mute)", textAlign: "center" }}>
              No activity yet — this fills in when something happens on a bounty you posted or took.
            </div>
          ) : (
            items.map(item => (
              <Link
                key={item.id}
                href={`/bounty/${item.jobId}`}
                onClick={() => setOpen(false)}
                className="activity-item"
                style={{
                  display: "block", padding: "10px 12px", borderRadius: 10,
                  textDecoration: "none", color: "var(--ink-soft)", fontSize: 13,
                }}
              >
                <strong style={{ color: "var(--ink)" }}>#{item.jobId}</strong>
                {" — "}
                {ACTIVITY_LABELS[item.eventName] ?? item.eventName}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
