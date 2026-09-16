"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import {
  concat, encodeFunctionData, encodePacked, hashTypedData, isHex, parseAbi, recoverTypedDataAddress, size,
  type Address, type Hex,
} from "viem";
import { CONTRACTS } from "@/lib/contracts";
import { getActiveNetwork, getActiveNetworkName } from "@/lib/networks";

// ─── Arbitrator Safe handoff ─────────────────────────────────────────────────
//
// The Arc mainnet adapter was deployed with owner and arbitrator on the
// deployer and both handoffs to the 2-of-3 Safe already started. The Safe
// completes them by calling acceptOwner() and acceptArbitrator(), but
// app.safe.global does not list Arc mainnet (chain 5042), so there is no Safe
// UI to sign that transaction in. This page is the minimum replacement: it
// builds the one Safe transaction, lets each owner sign it with their own
// wallet (the same EIP-712 SafeTx the Safe UI asks for), collects signatures
// across accounts or devices, and executes once the threshold is met.
//
// It holds no key and grants nothing: a signature counts only if it recovers
// to a Safe owner, the hash is cross-checked against the Safe's own
// getTransactionHash, and the Safe verifies everything again on execution.

const network = getActiveNetwork();
const ENABLED = getActiveNetworkName() === "arc-mainnet";
const SAFE: Address = "0x74678c072Ca546f11466CD44eB7e21730a312a54";
// Canonical Safe v1.4.1 MultiSendCallOnly; runtime bytecode identical to Base's, checked on chain 5042.
const MULTISEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function checkSignatures(bytes32 dataHash, bytes data, bytes signatures) view",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
]);
const ADAPTER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function arbitrator() view returns (address)",
  "function pendingArbitrator() view returns (address)",
  "function acceptOwner()",
  "function acceptArbitrator()",
]);
const MULTISEND_ABI = parseAbi(["function multiSend(bytes transactions)"]);

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
const DOMAIN = { chainId: network.chainId, verifyingContract: SAFE } as const;

type OnChain = {
  owners: Address[];
  threshold: bigint;
  safeNonce: bigint;
  owner: Address;
  pendingOwner: Address;
  arbitrator: Address;
  pendingArbitrator: Address;
};
type SafeTx = {
  to: Address; value: bigint; data: Hex; operation: number; safeTxGas: bigint; baseGas: bigint;
  gasPrice: bigint; gasToken: Address; refundReceiver: Address; nonce: bigint;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One Safe transaction accepting whatever is still pending; a MultiSend when both are. */
function buildSafeTx(s: OnChain): { tx: SafeTx; calls: string[] } | null {
  const calls: { name: string; data: Hex }[] = [];
  if (same(s.pendingOwner, SAFE)) {
    calls.push({ name: "acceptOwner()", data: encodeFunctionData({ abi: ADAPTER_ABI, functionName: "acceptOwner" }) });
  }
  if (same(s.pendingArbitrator, SAFE)) {
    calls.push({ name: "acceptArbitrator()", data: encodeFunctionData({ abi: ADAPTER_ABI, functionName: "acceptArbitrator" }) });
  }
  if (calls.length === 0) return null;
  const base = { value: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: s.safeNonce };
  if (calls.length === 1) {
    return { tx: { ...base, to: CONTRACTS.BOUNTY_ADAPTER, data: calls[0]!.data, operation: 0 }, calls: calls.map(c => c.name) };
  }
  const packed = concat(calls.map(c =>
    encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, CONTRACTS.BOUNTY_ADAPTER, 0n, BigInt(size(c.data)), c.data]),
  ));
  return {
    // DELEGATECALL into MultiSendCallOnly, exactly how the Safe UI batches calls.
    tx: { ...base, to: MULTISEND_CALL_ONLY, data: encodeFunctionData({ abi: MULTISEND_ABI, functionName: "multiSend", args: [packed] }), operation: 1 },
    calls: calls.map(c => c.name),
  };
}

const CODE: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains-mono), monospace",
  fontSize: 12,
  lineHeight: 1.6,
  background: "rgba(0,0,0,0.32)",
  border: "1px solid var(--g-border)",
  borderRadius: 12,
  padding: "12px 14px",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "var(--ink-soft)",
};

export default function SafePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<OnChain | null>(null);
  const [hashOnChain, setHashOnChain] = useState<Hex | null>(null);
  const [signatures, setSignatures] = useState<Record<string, Hex>>({});
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicClient || !ENABLED) return;
    const adapter = CONTRACTS.BOUNTY_ADAPTER;
    const [owners, threshold, safeNonce, owner, pendingOwner, arbitrator, pendingArbitrator] = await Promise.all([
      publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getOwners" }),
      publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getThreshold" }),
      publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "nonce" }),
      publicClient.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "owner" }),
      publicClient.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "pendingOwner" }),
      publicClient.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "arbitrator" }),
      publicClient.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "pendingArbitrator" }),
    ]);
    setState({ owners: [...owners], threshold, safeNonce, owner, pendingOwner, arbitrator, pendingArbitrator });
  }, [publicClient]);

  useEffect(() => {
    load().catch(e => setError(`Could not read the Safe or the adapter: ${e instanceof Error ? e.message : String(e)}`));
  }, [load]);

  const built = useMemo(() => (state ? buildSafeTx(state) : null), [state]);
  const safeTxHash = useMemo(
    () => (built ? hashTypedData({ domain: DOMAIN, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: built.tx }) : null),
    [built],
  );
  const storageKey = safeTxHash ? `arcbounty-safe-signatures-${safeTxHash}` : null;

  // The page's own EIP-712 hash must equal the Safe's, or nothing gets signed.
  useEffect(() => {
    if (!publicClient || !built) { setHashOnChain(null); return; }
    const t = built.tx;
    publicClient.readContract({
      address: SAFE, abi: SAFE_ABI, functionName: "getTransactionHash",
      args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, t.nonce],
    }).then(setHashOnChain).catch(() => setHashOnChain(null));
  }, [publicClient, built]);
  const hashVerified = Boolean(safeTxHash && hashOnChain && same(safeTxHash, hashOnChain));

  // Signatures survive switching wallet accounts and reloads, per transaction.
  useEffect(() => {
    if (!storageKey) return;
    try { setSignatures(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { setSignatures({}); }
  }, [storageKey]);
  const save = (next: Record<string, Hex>) => {
    setSignatures(next);
    try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };

  const isOwner = Boolean(address && state?.owners.some(o => same(o, address)));
  const collected = Object.keys(signatures).length;
  const ready = Boolean(state && collected >= Number(state.threshold));

  async function addSignature(signature: Hex): Promise<string> {
    if (!built || !state) throw new Error("Nothing to sign.");
    const signer = await recoverTypedDataAddress({ domain: DOMAIN, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: built.tx, signature });
    const owner = state.owners.find(o => same(o, signer));
    if (!owner) throw new Error(`That signature is from ${signer}, which is not an owner of this Safe.`);
    save({ ...signatures, [owner.toLowerCase()]: signature });
    return owner;
  }

  async function sign() {
    if (!built) return;
    setError(null); setMessage(null); setBusy("sign");
    try {
      if (chainId !== network.chainId) await switchChainAsync({ chainId: network.chainId });
      const signature = await signTypedDataAsync({ domain: DOMAIN, types: SAFE_TX_TYPES, primaryType: "SafeTx", message: built.tx });
      const owner = await addSignature(signature);
      setMessage(`Signed by ${owner}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addPasted() {
    setError(null); setMessage(null);
    const found = pasted.match(/0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/g) ?? [];
    if (found.length === 0) { setError("No 65-byte signature found in the pasted text."); return; }
    try {
      const owners = [];
      for (const sig of found) if (isHex(sig)) owners.push(await addSignature(sig as Hex));
      setMessage(`Added signature(s) from ${owners.join(", ")}.`);
      setPasted("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Owner-sorted and concatenated: the order Safe's checkNSignatures requires. */
  const packedSignatures = useMemo(() => {
    const entries = Object.entries(signatures).sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1));
    return entries.length ? concat(entries.map(([, s]) => s)) : null;
  }, [signatures]);

  async function execute() {
    if (!built || !packedSignatures || !publicClient || !safeTxHash) return;
    setError(null); setMessage(null); setBusy("execute");
    try {
      if (chainId !== network.chainId) await switchChainAsync({ chainId: network.chainId });
      await publicClient.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "checkSignatures", args: [safeTxHash, "0x", packedSignatures] });
      const t = built.tx;
      const hash = await writeContractAsync({
        address: SAFE, abi: SAFE_ABI, functionName: "execTransaction",
        args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, packedSignatures],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      setMessage(`Executed in block ${receipt.blockNumber}: ${hash}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ENABLED) {
    return (
      <div className="panel">
        <div className="panel-head"><span className="title">Arbitrator Safe</span></div>
        <p style={{ margin: 0 }}>This tool is for the Arc mainnet build. Other networks sign in app.safe.global.</p>
      </div>
    );
  }

  const role = (label: string, current?: Address, pending?: Address) => (
    <div>
      {label}: {current ?? "…"}
      {current && same(current, SAFE) ? "  (the Safe)" : pending && same(pending, SAFE) ? "  (handoff to the Safe pending)" : ""}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <h1>Arbitrator Safe</h1>
        <p className="sub">
          Owners of the {network.name} Safe sign the handoff of the adapter&apos;s owner and arbitrator roles here, because
          app.safe.global does not list {network.name} yet. Each owner signs with their own wallet; once {state ? state.threshold.toString() : "2"} have
          signed, anyone with a little USDC for gas can execute.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="title">State on chain</span></div>
        <div style={CODE}>
          <div>Safe: {SAFE}  ({state ? `${state.threshold} of ${state.owners.length}, nonce ${state.safeNonce}` : "loading"})</div>
          <div>Adapter: {CONTRACTS.BOUNTY_ADAPTER}</div>
          {role("owner", state?.owner, state?.pendingOwner)}
          {role("arbitrator", state?.arbitrator, state?.pendingArbitrator)}
        </div>
      </div>

      {state && !built && (
        <div className="panel">
          <div className="panel-head"><span className="title">Nothing to sign</span></div>
          <p style={{ margin: 0 }}>
            {same(state.owner, SAFE) && same(state.arbitrator, SAFE)
              ? "Handoff complete: the Safe is both owner and arbitrator."
              : "No handoff to this Safe is pending on the adapter."}
          </p>
        </div>
      )}

      {built && safeTxHash && (
        <div className="panel">
          <div className="panel-head"><span className="title">Safe transaction #{built.tx.nonce.toString()}</span></div>
          <div style={CODE}>
            <div>calls: {built.calls.join(" + ")}</div>
            <div>safeTxHash: {safeTxHash}</div>
            <div>{hashVerified ? "matches the Safe's own getTransactionHash" : "checking against the Safe…"}</div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
            <button type="button" className="btn" disabled={!isConnected || !isOwner || !hashVerified || busy !== null} onClick={sign}>
              {busy === "sign" ? "Signing…" : address && signatures[address.toLowerCase()] ? "Signed - sign again" : "Sign as this owner"}
            </button>
            <button type="button" className="btn" disabled={!ready || !hashVerified || busy !== null || !isConnected} onClick={execute}>
              {busy === "execute" ? "Executing…" : `Execute (${collected} of ${state?.threshold.toString()} signatures)`}
            </button>
          </div>
          {!isConnected && <p style={{ marginBottom: 0 }}>Connect a wallet with the button at the top to sign.</p>}
          {isConnected && !isOwner && <p style={{ marginBottom: 0 }}>{address} is not an owner of this Safe. Switch accounts in your wallet to sign.</p>}

          {collected > 0 && (
            <>
              <p style={{ marginBottom: 6 }}>Collected signatures - send this to the next owner, or keep it for execution:</p>
              <div style={CODE}>{Object.entries(signatures).map(([o, s]) => `${o}:${s}`).join("\n")}</div>
            </>
          )}

          <p style={{ marginBottom: 6 }}>Paste a signature another owner sent you:</p>
          <textarea
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            rows={3}
            style={{ ...CODE, width: "100%", boxSizing: "border-box", resize: "vertical" }}
            placeholder="0xowner:0xsignature"
          />
          <button type="button" className="btn" style={{ marginTop: 8 }} disabled={!pasted.trim()} onClick={addPasted}>
            Add signature
          </button>
        </div>
      )}

      {message && <div className="panel"><p style={{ margin: 0 }}>{message}</p></div>}
      {error && <div className="panel warning"><p style={{ margin: 0 }}>{error}</p></div>}
    </>
  );
}
