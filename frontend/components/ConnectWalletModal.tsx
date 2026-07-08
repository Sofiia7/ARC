"use client";

import { useConnect, type Connector } from "wagmi";
import { toast } from "sonner";
import { Modal } from "@/components/Modal";

type Props = {
  onClose: () => void;
};

function copyFor(connector: Connector): { title: string; hint: string } {
  if (connector.id === "xyz.ithaca.porto" || connector.name.toLowerCase().includes("porto")) {
    return { title: "Sign in with passkey", hint: "No extension needed — gas paid in USDC" };
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

// Passkey first (no-install path), then browser extension, then QR — matches
// the order they were previously offered as separate navbar buttons.
function sortOrder(connector: Connector): number {
  if (connector.id === "xyz.ithaca.porto") return 0;
  if (connector.type === "injected") return 1;
  if (connector.id === "walletConnect") return 2;
  return 3;
}

export function ConnectWalletModal({ onClose }: Props) {
  const { connect, connectors } = useConnect();

  const options = [...connectors].sort((a, b) => sortOrder(a) - sortOrder(b));

  function handlePick(connector: Connector) {
    connect(
      { connector },
      {
        onSuccess: () => onClose(),
        onError: err => {
          const isInjected = connector.type === "injected";
          toast.error(
            isInjected
              ? "No browser wallet found — install MetaMask, or use Passkey / WalletConnect instead."
              : err.message || "Couldn't connect wallet.",
          );
        },
      },
    );
  }

  return (
    <Modal title="Connect a wallet" onClose={onClose}>
      <p className="modal-help">Pick how you&apos;d like to connect — you only need one.</p>
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
