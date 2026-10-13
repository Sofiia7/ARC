"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { parseAbi, type Address } from "viem";
import { BOUNTY_ADAPTER_V48_ABI as ABI } from "@/lib/abi-v48";
import { CONTRACTS } from "@/lib/contracts";
import { getActiveNetwork } from "@/lib/networks";
import { fetchIpfsText } from "@/lib/ipfs";
import type { ContestEncryptionKeypair } from "@/lib/contestEncryption";
import { deriveMeraContestKey } from "@/lib/mera";
import { nadTitleOf } from "@/lib/nadStatus";
import { useTx } from "@/hooks/useTx";
import { friendlyTxError } from "@/lib/txErrors";
import { ConnectWalletModal } from "./ConnectWalletModal";
import flow from "./NadFlow.module.css";

// Shared hooks, constants and small components used by NadBoard, NadPost and NadDetail.
export type { Meta, Entry } from "@/lib/nadStatus";

export const escrowAbi = parseAbi([
  "function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))",
]);
export const identityAbi = parseAbi([
  "function ownerOf(uint256) view returns(address)",
  "function getAgentWallet(uint256) view returns(address)",
]);
const deriveContestKeypair = async (
  ...args: Parameters<typeof import("@/lib/contestEncryption").deriveContestKeypair>
) => (await import("@/lib/contestEncryption")).deriveContestKeypair(...args);
export const encryptContestEntry = async (
  ...args: Parameters<typeof import("@/lib/contestEncryption").encryptContestEntry>
) => (await import("@/lib/contestEncryption")).encryptContestEntry(...args);
export const decryptContestEntry = async (
  ...args: Parameters<typeof import("@/lib/contestEncryption").decryptContestEntry>
) => (await import("@/lib/contestEncryption")).decryptContestEntry(...args);
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const button = "btn btn-primary";
export const keyMessage = (owner: Address) =>
  `NadBounty contest encryption key v1\nchain: ${getActiveNetwork().chainId}\nadapter: ${CONTRACTS.BOUNTY_ADAPTER}\nposter: ${owner.toLowerCase()}\nPurpose: derive a private encryption key locally. This signature does not authorize a transaction.`;
export function usePosterKey() {
  const { address, connector } = useAccount();
  const { data: wallet } = useWalletClient();
  return async (owner = address): Promise<ContestEncryptionKeypair> => {
    if (!wallet || !address || !owner || owner.toLowerCase() !== address.toLowerCase())
      throw Error("Connect the poster wallet to recover its encryption key.");
    if (connector?.type === "mera") return deriveMeraContestKey(keyMessage(owner));
    const signature = await wallet.signMessage({ account: address, message: keyMessage(owner) });
    return deriveContestKeypair(
      new Uint8Array(
        signature
          .slice(2)
          .match(/../g)!
          .map((b) => parseInt(b, 16)),
      ),
      keyMessage(owner),
    );
  };
}
export function WalletPrompt({ big }: { big?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`btn btn-primary${big ? " btn-big" : ""}`} onClick={() => setOpen(true)}>
        Connect wallet
      </button>
      {open && <ConnectWalletModal onClose={() => setOpen(false)} />}
    </>
  );
}
/** An error whose message is already written for people: shown as it is, never re-classified. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
/** One readable sentence for anything thrown while preparing or sending a transaction. */
export function errorText(error: unknown, action?: string): string {
  if (error instanceof UserError) return error.message;
  return friendlyTxError(error, action ? { action } : undefined);
}
type SendParams = Parameters<ReturnType<typeof useTx>["send"]>[0];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function useNadWrite() {
  const { send, busy, lastError } = useTx();
  // useTx stores the failure in React state, which a running async function cannot read until the next render. The ref
  // always holds the latest value; after a failed send we wait briefly for the render that carries the new message.
  const lastErrorRef = useRef<string | null>(null);
  lastErrorRef.current = lastError;
  async function failureReason(fallback: string) {
    for (let i = 0; i < 20 && !lastErrorRef.current; i++) await sleep(25);
    return lastErrorRef.current ?? fallback;
  }
  return {
    busy,
    lastError,
    async write(name: string, args: unknown[]) {
      lastErrorRef.current = null;
      const hash = await send({ address: CONTRACTS.BOUNTY_ADAPTER, abi: ABI, functionName: name, args });
      if (!hash) throw new UserError(await failureReason("Transaction was not confirmed."));
      return hash;
    },
    /** Like send, but throws the real reason (rejected in the wallet, reverted, no gas ...) when nothing was confirmed. */
    async sendOrThrow(params: SendParams, fallback: string) {
      lastErrorRef.current = null;
      const hash = await send(params);
      if (!hash) throw new UserError(await failureReason(fallback));
      return hash;
    },
    send,
  };
}

/**
 * A checkbox row or one option of a radio group, built from the shared checkbox-row look. Keyboard: Tab to focus,
 * Space or Enter to choose; in a radio group the arrow keys move the choice (the selected option is the tab stop).
 */
export function ChoiceRow({
  kind,
  checked,
  onSelect,
  name,
  desc,
  describedBy,
}: {
  kind: "radio" | "checkbox";
  checked: boolean;
  onSelect: () => void;
  name: string;
  desc: ReactNode;
  describedBy?: string;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onSelect();
      return;
    }
    if (kind !== "radio") return;
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const options = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    const next = options[(options.indexOf(e.currentTarget) + step + options.length) % options.length];
    next?.focus();
    next?.click();
  }
  return (
    <div
      className={`checkbox-row ${flow.choice}${kind === "radio" ? ` ${flow.radio}` : ""}`}
      role={kind}
      aria-checked={checked}
      aria-describedby={describedBy}
      data-on={checked}
      tabIndex={kind === "radio" && !checked ? -1 : 0}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className="check" aria-hidden="true" />
      <div className="body">
        <div className="name">{name}</div>
        <div className="desc">{desc}</div>
      </div>
    </div>
  );
}

/** A button that, when it cannot be used, says why in a sentence next to it (and links the sentence for screen readers). */
export function ActionButton({
  id,
  label,
  onClick,
  disabled,
  reason,
  className = button,
}: {
  id: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  reason?: string | null;
  className?: string;
}) {
  const reasonId = `${id}-reason`;
  return (
    <div className={flow.actionItem}>
      <button
        type="button"
        id={id}
        className={className}
        disabled={disabled || !!reason}
        aria-describedby={reason ? reasonId : undefined}
        onClick={onClick}
      >
        {label}
      </button>
      {reason && (
        <p id={reasonId} className={flow.reason}>
          {reason}
        </p>
      )}
    </div>
  );
}

const titleCache = new Map<string, string | null>();
export function NadTitle({ cid }: { cid: string }) {
  const [title, setTitle] = useState<string | null | undefined>(() => titleCache.get(cid));
  useEffect(() => {
    if (titleCache.has(cid)) {
      setTitle(titleCache.get(cid));
      return;
    }
    let cancelled = false;
    fetchIpfsText(cid)
      .then((text) => {
        const t = nadTitleOf(text) || null;
        titleCache.set(cid, t);
        if (!cancelled) setTitle(t);
      })
      .catch(() => {
        titleCache.set(cid, null);
        if (!cancelled) setTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cid]);
  if (title === undefined) return <div className="bounty-title skeleton" />;
  if (title === null) return <div className="hash">{cid}</div>;
  return <div className="bounty-title">{title}</div>;
}
