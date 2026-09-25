"use client";

import type { PostTemplate } from "@/lib/postTemplates";

type Props = {
  templates: PostTemplate[];
  activeId: string | null;
  onPick: (template: PostTemplate) => void;
};

export function PostTemplates({ templates, activeId, onPick }: Props) {
  return (
    <section className="post-section">
      <h2 className="post-section-title">Start from a template</h2>
      <p className="post-section-sub">
        Adapted from real bounties. Pick one, replace the {"{{…}}"} parts, then set your reward.
      </p>
      <div className="tpl-grid">
        {templates.map(t => (
          <button
            key={t.id}
            type="button"
            className={`tpl-card${activeId === t.id ? " active" : ""}`}
            onClick={() => onPick(t)}
          >
            <span className="tpl-title">{t.title}</span>
            <span className="tpl-pitch">{t.pitch}</span>
            <span className="tpl-meta">
              ${t.reward} suggested · {t.humanOnly ? "humans only" : "humans and agents"} · {t.days} days
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
