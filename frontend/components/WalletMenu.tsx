"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/format";
import { getActiveNetwork } from "@/lib/networks";

/**
 * The connected wallet in the navbar. Clicking the short address used to disconnect at once, and the full address was
 * shown nowhere, so a passkey wallet (no wallet app to read it from) could not be funded. The button now opens a small
 * menu with the full address, a copy button, an explorer link and, separately, Disconnect.
 */
export function WalletMenu() {
  const { address, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLElement>(null);
  const network = getActiveNetwork();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!address) return null;
  const isPasskey = connector?.type === "mera";
  const gas = network.nativeCurrency.symbol;

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(address as string);
      ok = true;
    } catch {
      // Clipboard API blocked (insecure context, permissions): select the text so Ctrl+C works.
    }
    if (!ok && addressRef.current) {
      const range = document.createRange();
      range.selectNodeContents(addressRef.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn wallet"
        title="Your wallet: copy the address or disconnect"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span className="dot" />
        {shortAddress(address)}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Your wallet"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 340,
            maxWidth: "calc(100vw - 32px)",
            zIndex: 50,
            background: "var(--g-bg)",
            border: "1px solid var(--g-border)",
            borderRadius: 14,
            backdropFilter: "var(--g-blur)",
            WebkitBackdropFilter: "var(--g-blur)",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {isPasskey ? "Your passkey wallet" : "Your wallet"} on {network.name}
          </div>
          <code
            ref={addressRef}
            style={{ wordBreak: "break-all", fontSize: 13, lineHeight: 1.5, userSelect: "all" }}
            data-testid="wallet-full-address"
          >
            {address}
          </code>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={copy} className="btn btn-primary" style={{ fontSize: 13, padding: "8px 14px" }}>
              {copied ? "Copied" : "Copy address"}
            </button>
            <a
              href={`${network.explorerUrl}/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              style={{ fontSize: 13, padding: "8px 14px", textDecoration: "none" }}
            >
              View on explorer
            </a>
          </div>
          {isPasskey && (
            <p style={{ fontSize: 12, lineHeight: 1.5, opacity: 0.8, margin: 0 }}>
              To use this wallet, send it {gas} for gas and USDC for rewards on {network.name}. Send only on this network.
              The address stays the same every time you sign in with the same passkey.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
            className="btn"
            style={{ fontSize: 13, padding: "8px 14px", alignSelf: "flex-start" }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
