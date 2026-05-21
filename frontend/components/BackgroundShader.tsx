"use client";

import Script from "next/script";

/**
 * Mounts the WebGL sunrise background.
 * - <canvas id="bg"> takes the full viewport at z-0
 * - .vignette overlays a soft top/bottom fade at z-1
 * - .dawn-edge shows scroll progress as a sunrise meter at the right edge
 *
 * arcbounty-bg.js (in /public) is a self-contained IIFE that finds the canvas
 * and the optional #dawnFill / #dawnKnob elements and animates them.
 *
 * Real page content lives inside <div class="page"> at z-2 (set in layout).
 */
export function BackgroundShader() {
  return (
    <>
      <canvas id="bg" />
      <div className="vignette" />
      <div className="dawn-edge" aria-hidden="true">
        <div className="track">
          <div className="fill" id="dawnFill" />
          <div className="knob" id="dawnKnob" />
        </div>
        <div className="cap">DAWN</div>
      </div>
      <Script src="/arcbounty-bg.js" strategy="afterInteractive" />
    </>
  );
}
