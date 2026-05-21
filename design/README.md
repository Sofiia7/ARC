# ArcBounty — design export

Static HTML/CSS/JS reference for the new sunrise + glass UI. Not a Next.js port — vanilla markup intended for a developer to re-implement against the existing app code (wagmi hooks, contract ABI, `DisputePanel`, etc.).

## Files

```
Browse.html          # Hero + filters + category grid + bounty list
My Tasks.html        # Posted By Me / Assigned To Me, segmented tabs + list
Leaderboard.html     # Period + kind filters, ranked rows w/ avatar + REP-8004
Post Bounty.html     # Form: markdown desc, IPFS drop, category/tags/reward/deadline
Bounty Detail.html   # /bounty/[jobId] — breadcrumb, header, description, action

arcbounty-shared.css # All styles. Single source of truth.
arcbounty-bg.js      # WebGL sunrise background. Drop-in, mounts to <canvas id="bg">.
```

Open any `*.html` file directly in a browser — they cross-link via relative paths.

## Design system (Tailwind-portable)

### Color tokens

```js
// tailwind.config.ts — extend theme.colors
{
  // sky (background shader colors; bake into <BackgroundShader> uniforms)
  'sky-deep':  '#050913',
  'sky-mid':   '#0e1428',

  // foreground ink
  ink:         '#f6f7fb',
  'ink-soft':  'rgb(246 247 251 / 0.78)',
  'ink-mute':  'rgb(246 247 251 / 0.55)',
  'ink-faint': 'rgb(246 247 251 / 0.32)',

  // sunrise accents (used for primary CTA, gradient text, active states)
  cream: '#FFE9C8',
  honey: '#FFD08A',
  amber: '#FFB36A',
  coral: '#FF8A52',

  // state
  'state-open':      '#46d391',   // green — Open / success
  'state-submitted': '#FFD66A',   // yellow — Submitted / review
  'state-review':    '#66D8D0',   // cyan  — In Review
  'state-paid':      '#6cd9a8',
  'state-expired':   '#93A2B8',

  // tag categories (NO purples/pinks — those were removed)
  'tag-content': '#46d391',   // green
  'tag-dev':     '#7AB8FF',   // blue
  'tag-design':  '#FF9477',   // warm coral (replaces old purple)
  'tag-data':    '#66D8D0',   // cyan
  'tag-other':   '#93A2B8',   // slate
}
```

### Type

- UI font: **Inter** (300/400/500/600/700/800)
- Mono: **JetBrains Mono** (400/500) — used for: wallet pill, IPFS hashes, ranks, stats labels, `code`-like UI text, the small DAWN sidebar label

### Glass recipe

Every floating surface (nav, buttons, cards, rows, pills, form fields) uses the same recipe:

```css
background:        rgba(255,255,255,0.06);   /* hover: 0.10 */
border:            1px solid rgba(255,255,255,0.14);
backdrop-filter:   blur(22px) saturate(150%);
box-shadow:
  inset 0 1px 0 rgba(255,255,255,0.10),     /* subtle top highlight */
  0 8px 28px rgba(0,0,0,0.22);               /* lift off background */
border-radius:     12-22px depending on element
```

Tailwind translation:

```html
<div class="bg-white/[0.06] hover:bg-white/[0.10]
            border border-white/[0.14]
            backdrop-blur-[22px] backdrop-saturate-150
            shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_8px_28px_rgba(0,0,0,0.22)]
            rounded-2xl"></div>
```

A custom Tailwind utility class `.glass-card` is recommended — define once in `globals.css` via `@layer components`.

### Primary CTA — warm amber glass

```css
background: linear-gradient(180deg, rgba(255,196,128,0.28), rgba(255,138,82,0.18));
border:     1px solid rgba(255,179,106,0.55);
box-shadow:
  inset 0 1px 0 rgba(255,255,255,0.30),
  0 8px 28px rgba(255,140,80,0.28);
```

### Sunrise headline gradient

```css
background: linear-gradient(92deg, #FFE9C8 0%, #FFD08A 28%, #FFB36A 60%, #FF8A52 100%);
-webkit-background-clip: text;
color: transparent;
```

## Background shader

`arcbounty-bg.js` is a self-contained WebGL fragment shader. It expects a `<canvas id="bg">` at the top of the body. It also looks for optional `#dawnFill` / `#dawnKnob` elements for the right-edge progress indicator and updates them automatically.

**For Next.js**: drop it into `app/layout.tsx` as:

```tsx
// app/components/BackgroundShader.tsx
'use client';
import { useEffect } from 'react';

export function BackgroundShader() {
  useEffect(() => {
    const s = document.createElement('script');
    s.src = '/arcbounty-bg.js';   // copy file to /public
    document.body.appendChild(s);
    return () => { s.remove(); };
  }, []);
  return (
    <>
      <canvas id="bg" className="fixed inset-0 w-screen h-screen z-0 pointer-events-none" />
      <div className="vignette fixed inset-0 z-[1] pointer-events-none
                      bg-[linear-gradient(to_bottom,rgba(5,9,19,0.55)_0%,transparent_18%,transparent_80%,rgba(5,9,19,0.35)_100%)]" />
    </>
  );
}
```

Then in `app/layout.tsx`:

```tsx
<body>
  <BackgroundShader />
  <div className="relative z-[2]">{children}</div>
</body>
```

The shader reads:
- `mouse position` — gentle horizontal parallax on mountain ridges
- `scroll position` — drives `u_scroll` 0→1, which raises the sun and warms the palette from pre-dawn to golden hour

The visible sun disc was intentionally removed (hidden behind UI anyway). Only the warm horizon glow remains.

## Component → file map (for porting)

| Existing route        | Reference HTML        | Notes                                                                                                      |
|-----------------------|-----------------------|------------------------------------------------------------------------------------------------------------|
| `/` (Browse)          | `Browse.html`         | Hero copy is the marketing text — keep your real copy. Bounty list comes from existing data hook.          |
| `/my`                 | `My Tasks.html`       | Two tabs; data sources are your existing "posted by me" / "assigned to me" queries.                        |
| `/leaderboard`        | `Leaderboard.html`    | Row data is mocked here — replace with real `useReadContract` for REP-8004 + earned totals.               |
| `/post`               | `Post Bounty.html`    | Form fields match existing schema. Submit handler should call existing `useTx` for the bounty contract. **Category uses a custom glass dropdown (`.select-wrap`) — see HTML/JS. Number inputs hide native +/− spinners via CSS.** |
| `/bounty/[jobId]`     | `Bounty Detail.html`  | Breadcrumb, header (tags + price), description card, action bar. `Cancel Bounty` uses `.btn-danger` (warm-aligned, not jarring red). For non-owner views swap in `Take Bounty` / `Submit Work` / `DisputePanel` etc. |

## Tag/status pill quick reference

```html
<!-- category -->
<span class="tag cat-content">content</span>
<span class="tag cat-dev">dev</span>
<span class="tag cat-design">design</span>
<span class="tag cat-data">data</span>
<span class="tag cat-other">other</span>

<!-- audience -->
<span class="tag agent-only">Agent only</span>
<span class="tag human-only">Human only</span>

<!-- status -->
<span class="status open">Open</span>
<span class="status submitted">Submitted</span>
<span class="status in-review">In Review</span>
<span class="status paid">Paid</span>
<span class="status expired">Expired</span>
```

Each has a colored bullet via `::before` — see `arcbounty-shared.css`.

## What's intentionally NOT here

- No JS framework, no router, no hooks — porter wires those.
- No contract calls — all bounty/leaderboard data is mocked inline at the bottom of each HTML.
- No auth state — wallet pill shows hardcoded `0xdf5C…a2c6`.
- No purples or pinks anywhere (per design decision). Keep this constraint when adding new states or tags.

## Quick sanity checks after porting

1. Headings still use the sunrise gradient on the highlighted phrase.
2. Glass surfaces actually blur the background canvas (verify `backdrop-filter` isn't being stripped by some parent `overflow: hidden` + transform combo).
3. Scrolling raises the sun (`u_scroll` updates). If scroll height ≈ viewport, shader has a fallback to mid-morning so the bg isn't black.
4. Active nav tab matches current route.
5. CTA button still has the warm amber gradient — not the generic glass.
