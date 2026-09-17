"use client";

import { useConnect, type Connector } from "wagmi";
import { toast } from "sonner";
import { Modal } from "@/components/Modal";
import { isGasPaidInUsdc } from "@/lib/networks";

type Props = {
  onClose: () => void;
};

const PORTO_ID = "xyz.ithaca.porto";

function copyFor(connector: Connector): { title: string; hint: string } {
  if (connector.id === PORTO_ID || connector.name.toLowerCase().includes("porto")) {
    // "gas paid in USDC" is an Arc property, not a Porto one - on Base gas is
    // ETH, so stating it unconditionally would be a lie on that build.
    return {
      title: "Sign in with passkey",
      hint: isGasPaidInUsdc() ? "No extension needed - gas paid in USDC" : "No extension needed",
    };
  }
  if (connector.id === "walletConnect") {
    return { title: "WalletConnect", hint: "Scan a QR code with your mobile wallet" };
  }
  if (connector.type === "injected") {
    const title = connector.name === "Injected" ? "Browser wallet" : connector.name;
    return { title, hint: "MetaMask or another extension already installed" };
  }
  return { title: connector.name, hint: "" };
}

// Passkey first (no-install path), then browser extension, then QR - matches
// the order they were previously offered as separate navbar buttons.
function sortOrder(connector: Connector): number {
  if (connector.id === PORTO_ID) return 0;
  if (connector.type === "injected") return 1;
  if (connector.id === "walletConnect") return 2;
  return 3;
}

export function ConnectWalletModal({ onClose }: Props) {
  const { connect, connectors } = useConnect();

  // The plain "injected" connector (id "injected", name "Injected" → shown
  // as "Browser wallet") is a fallback for wallets that don't support
  // EIP-6963. When a real wallet (e.g. Rabby) has announced itself via
  // EIP-6963, it's a separate connector targeting the same window.ethereum
  // slot - showing both is just the same wallet listed twice. Porto is typed
  // "injected" too but is no extension: counting it hid the fallback on every
  // build. With no window.ethereum at all there is nothing for it to reach.
  const hasNamedInjected = connectors.some(c => c.type === "injected" && c.id !== "injected" && c.id !== PORTO_ID);
  const hasWindowEthereum = typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
  const options = connectors
    .filter(c => !(c.id === "injected" && (hasNamedInjected || !hasWindowEthereum)))
    .sort((a, b) => sortOrder(a) - sortOrder(b));
  const alternatives = [
    connectors.some(c => c.id === PORTO_ID) && "Passkey",
    connectors.some(c => c.id === "walletConnect") && "WalletConnect",
  ].filter(Boolean).join(" / ");

  function handlePick(connector: Connector) {
    connect(
      { connector },
      {
        onSuccess: () => onClose(),
        onError: err => {
          // Only the fallback can be missing: a named wallet announced itself.
          const isFallback = connector.id === "injected";
          toast.error(
            isFallback
              ? `No browser wallet found - install MetaMask${alternatives ? `, or use ${alternatives} instead` : ""}.`
              : err.message || "Couldn't connect wallet.",
          );
        },
      },
    );
  }

  return (
    <Modal title="Connect a wallet" onClose={onClose}>
      <p className="modal-help">Pick how you&apos;d like to connect - you only need one.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {options.map(connector => {
          const { title, hint } = copyFor(connector);
          return (
            <button
              key={connector.uid}
              type="button"
              className="btn"
              style={{ justifyContent: "flex-start", textAlign: "left", padding: "12px 16px", width: "100%" }}
              onClick={() => handlePick(connector)}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{title}</div>
                {hint && <div style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 2 }}>{hint}</div>}
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
