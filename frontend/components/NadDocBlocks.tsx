"use client";

import { useState } from "react";
import styles from "./NadDocs.module.css";

/** A code sample with a copy button. The block scrolls sideways inside the panel; the page never does. */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [state, setState] = useState<"" | "copied" | "failed">("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState(""), 2500);
  }
  return (
    <div>
      <div className={styles.codeHead}>
        <span className={styles.codeLabel}>{label}</span>
        <button type="button" className={`btn ${styles.copyBtn}`} onClick={() => void copy()}>
          {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
        </button>
      </div>
      <pre className={styles.code} tabIndex={0} aria-label={label}>
        {code}
      </pre>
    </div>
  );
}
