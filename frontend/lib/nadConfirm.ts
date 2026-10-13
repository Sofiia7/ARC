import { decodeFunctionData, formatUnits, hexToString, parseAbi, type Abi, type Hex } from "viem";
import { BOUNTY_ADAPTER_V48_ABI } from "./abi-v48";
import { formatUsdc } from "./txErrors";

// A small confirmation dialog that needs no React tree (so the passkey
// connector in lib/mera.ts can await it from inside an EIP-1193 request) plus
// the plain-language descriptions of what a passkey wallet is being asked to
// sign. window.confirm showed raw hex that phones truncate; this shows what the
// person is doing first and keeps the raw payload in a collapsed section.
//
// Everything is set with textContent: bodies can contain user-controlled
// strings (message text, typed-data fields) and must never be parsed as HTML.

export type ConfirmOptions = {
  title: string;
  /** Plain-language explanation. Line breaks are kept. */
  body: string;
  /** Technical payload, shown inside a collapsed "Technical details" section. */
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

let dialogCounter = 0;
/** Open dialogs, newest last. Only the newest one reacts to the keyboard. */
const openDialogs: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.getClientRects().length > 0);
}

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Asks the person to confirm. Resolves true on the confirm button, false on
 * cancel, Escape or a click on the backdrop. Resolves false (without showing
 * anything) when there is no DOM, so callers fail closed on the server.
 *
 * Keyboard focus starts on the cancel button, so a stray Enter or Space cannot
 * approve a transaction, and returns to the element that opened the dialog.
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const uid = ++dialogCounter;
    const token = Symbol(`nad-confirm-${uid}`);
    const titleId = `nad-confirm-title-${uid}`;
    const bodyId = `nad-confirm-body-${uid}`;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Reuses the design system's modal classes (app/globals.css); sits one
    // layer above Modal so it can open on top of the connect-wallet modal.
    const backdrop = create("div", "modal-backdrop");
    backdrop.style.zIndex = "110";

    const card = create("div", "modal-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", titleId);
    card.setAttribute("aria-describedby", bodyId);
    card.tabIndex = -1;
    card.style.outline = "none";

    const head = create("div", "modal-head");
    const heading = create("h2", undefined, String(opts.title));
    heading.id = titleId;
    heading.style.overflowWrap = "anywhere";
    head.append(heading);

    const body = create("p", "modal-help", String(opts.body));
    body.id = bodyId;
    body.style.whiteSpace = "pre-line";
    body.style.overflowWrap = "anywhere";

    card.append(head, body);

    if (opts.details) {
      const section = create("details");
      const summary = create("summary", undefined, "Technical details");
      summary.style.cursor = "pointer";
      summary.style.color = "var(--ink-soft)";
      summary.style.fontSize = "12.5px";
      const pre = create("pre", undefined, String(opts.details));
      pre.style.margin = "8px 0 0";
      pre.style.padding = "10px";
      pre.style.border = "1px solid var(--g-border)";
      pre.style.borderRadius = "10px";
      pre.style.background = "var(--g-bg)";
      pre.style.color = "var(--ink-mute)";
      pre.style.fontFamily = "var(--font-jetbrains-mono), monospace";
      pre.style.fontSize = "11.5px";
      pre.style.lineHeight = "1.5";
      pre.style.whiteSpace = "pre-wrap";
      pre.style.wordBreak = "break-all";
      pre.style.maxHeight = "180px";
      pre.style.overflow = "auto";
      section.append(summary, pre);
      card.append(section);
    }

    const actions = create("div", "modal-actions");
    const cancel = create("button", "btn", opts.cancelLabel ?? "Cancel");
    cancel.type = "button";
    const confirm = create("button", "btn btn-primary", opts.confirmLabel ?? "Confirm");
    confirm.type = "button";
    actions.append(cancel, confirm);
    card.append(actions);
    backdrop.append(card);

    let settled = false;
    function close(result: boolean) {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      const at = openDialogs.indexOf(token);
      if (at >= 0) openDialogs.splice(at, 1);
      backdrop.remove();
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    }

    // Capture phase on document: runs before the page's own handlers, and
    // stopPropagation keeps an Escape meant for this dialog from also closing
    // a Modal underneath it.
    function onKeyDown(event: KeyboardEvent) {
      if (openDialogs[openDialogs.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusableIn(card);
      if (nodes.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && card.contains(active);
      if (event.shiftKey && (!inside || active === first || active === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKeyDown, true);

    openDialogs.push(token);
    document.body.append(backdrop);
    cancel.focus({ preventScroll: true });
  });
}

// ─── Describing what a passkey wallet is asked to sign ───────────────────────

export type ConfirmCopy = { title: string; body: string; details: string };

export type SigningContext = {
  /** Chain display name, e.g. "Monad Testnet". */
  chainName: string;
  /** Product name, e.g. "NadBounty". */
  appName: string;
  /** Gas token symbol, e.g. "MON". */
  nativeSymbol: string;
  /** The wallet that would sign. */
  from?: string;
  /** Contract addresses that get a friendly name. */
  adapter?: string;
  usdc?: string;
  identity?: string;
  /** Gas limit and worst-case fee in wei, when known. */
  gas?: bigint;
  maxFee?: bigint;
};

const ADAPTER_ABI = BOUNTY_ADAPTER_V48_ABI as unknown as Abi;
const APPROVE_ABI = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const shortAddress = (address: string) =>
  ADDRESS.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : "an unknown address";

/** Native token amount for people: up to 6 decimals, never scientific notation. */
export function formatNative(wei: bigint): string {
  const [whole, fraction = ""] = formatUnits(wei, 18).split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  if (wei > 0n && whole === "0" && trimmed === "") return "less than 0.000001";
  return trimmed ? `${whole}.${trimmed}` : whole;
}

const plain = (value: unknown, indent?: number): string =>
  typeof value === "string"
    ? value
    : (JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), indent) ??
      String(value));

function humanize(functionName: string): string {
  const words = functionName
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Titles = Record<string, (args: readonly unknown[]) => { title: string; note?: string }>;

const asAgent = (agentId: unknown) => (typeof agentId === "bigint" && agentId !== 0n ? ` as agent #${agentId}` : "");

const ADAPTER_TITLES: Titles = {
  createBounty: (args) => {
    const params = (args[0] ?? {}) as { reward?: unknown; contest?: unknown };
    const reward = typeof params.reward === "bigint" ? ` with a ${formatUsdc(params.reward)} USDC reward` : "";
    return {
      title: `${params.contest === true ? "Post a contest" : "Post a bounty"}${reward}`,
      note: "The reward is locked in escrow until the bounty is settled or cancelled.",
    };
  },
  enterContest: (args) => ({ title: `Enter contest #${args[0]}${asAgent(args[1])}` }),
  replaceContestEntry: (args) => ({ title: `Replace your entry #${args[1]} in contest #${args[0]}` }),
  takeBounty: (args) => ({ title: `Take bounty #${args[0]}${asAgent(args[1])}` }),
  submitWork: (args) => ({ title: `Submit your work for bounty #${args[0]}` }),
  approveBounty: (args) => ({
    title: `Approve bounty #${args[0]} (score ${args[1]}/100)`,
    note: "The worker is paid from escrow.",
  }),
  autoApprove: (args) => ({ title: `Auto-approve bounty #${args[0]}`, note: "The worker is paid from escrow." }),
  rejectBounty: (args) => ({ title: `Reject the submission on bounty #${args[0]}` }),
  challengeRejection: (args) => ({ title: `Challenge the rejection on bounty #${args[0]}` }),
  cancelBounty: (args) => ({ title: `Cancel bounty #${args[0]}`, note: "Your escrowed reward is returned to you." }),
  expireBounty: (args) => ({
    title: `Expire bounty #${args[0]}`,
    note: "The escrowed reward goes back to the poster.",
  }),
  disputeBounty: (args) => ({ title: `Open a dispute on bounty #${args[0]}` }),
  pickContestWinners: (args) => ({
    title: `Pick the winners of contest #${args[0]}`,
    note: "Winners are paid from escrow.",
  }),
  withdraw: () => ({ title: "Withdraw your pending USDC", note: "Moves USDC owed to you into this wallet." }),
};

function decodeCall(
  data: Hex,
  abi: Abi,
): { functionName: string; args: readonly unknown[]; inputs: { name?: string; type: string }[] } | undefined {
  try {
    const decoded = decodeFunctionData({ abi, data });
    const item = (abi as readonly { type: string; name?: string; inputs?: { name?: string; type: string }[] }[]).find(
      (entry) => entry.type === "function" && entry.name === decoded.functionName,
    );
    return {
      functionName: decoded.functionName,
      args: (decoded.args ?? []) as readonly unknown[],
      inputs: item?.inputs ?? [],
    };
  } catch {
    return undefined;
  }
}

/**
 * What an eth_sendTransaction from the passkey wallet actually does, in words.
 * The raw calldata is only ever placed in `details`.
 */
export function describeTransaction(
  tx: { to: string; data?: string; value?: string },
  ctx: SigningContext,
): ConfirmCopy {
  const data = (tx.data && /^0x[0-9a-fA-F]*$/.test(tx.data) ? tx.data : "0x") as Hex;
  const contractName = same(tx.to, ctx.adapter)
    ? ctx.appName
    : same(tx.to, ctx.usdc)
      ? "USDC"
      : same(tx.to, ctx.identity)
        ? "the agent identity registry"
        : undefined;
  const target = shortAddress(tx.to);

  let call: ReturnType<typeof decodeCall> = undefined;
  let title: string | undefined;
  let note: string | undefined;

  if (same(tx.to, ctx.usdc) || !contractName) {
    call = decodeCall(data, APPROVE_ABI);
    if (call?.functionName === "approve") {
      const spender = String(call.args[0]);
      const amount = call.args[1] as bigint;
      const spenderName = same(spender, ctx.adapter) ? ctx.appName : shortAddress(spender);
      title =
        amount === 0n
          ? `Remove the USDC approval for ${spenderName}`
          : `Approve ${formatUsdc(amount)} USDC for ${spenderName}`;
      note =
        amount === 0n
          ? `${spenderName} will no longer be able to use your USDC.`
          : `Lets ${spenderName} use up to ${formatUsdc(amount)} USDC from this wallet. Nothing is sent yet.`;
    }
  }
  if (!title && (same(tx.to, ctx.adapter) || !contractName)) {
    call = decodeCall(data, ADAPTER_ABI);
    if (call) {
      const known = ADAPTER_TITLES[call.functionName]?.(call.args);
      if (known) {
        title = known.title;
        note = known.note;
      } else {
        const first = call.inputs[0]?.name === "jobId" ? ` (bounty #${call.args[0]})` : "";
        title = `${humanize(call.functionName)}${first}`;
      }
    }
  }
  if (!title) title = `Contract call to ${target}`;

  const value = tx.value && /^0x[0-9a-fA-F]+$/.test(tx.value) ? BigInt(tx.value) : 0n;
  const lines = [
    note,
    `Network: ${ctx.chainName}`,
    `Contract: ${contractName ? `${contractName} (${target})` : target}`,
    value === 0n ? `No ${ctx.nativeSymbol} is sent with this.` : `Sends ${formatNative(value)} ${ctx.nativeSymbol}.`,
    ctx.maxFee !== undefined ? `Network fee: up to ${formatNative(ctx.maxFee)} ${ctx.nativeSymbol}` : undefined,
  ].filter((line): line is string => !!line);
  if (!call) lines.unshift("This request could not be read. Confirm only if you just started this action.");

  const details = [
    ctx.from ? `From: ${ctx.from}` : undefined,
    `To: ${tx.to}`,
    call
      ? `Function: ${call.functionName}(${call.inputs.map((input) => `${input.type} ${input.name ?? ""}`.trim()).join(", ")})`
      : undefined,
    ...(call ? call.args.map((arg, index) => `  ${call?.inputs[index]?.name || `arg${index}`} = ${plain(arg)}`) : []),
    ctx.gas !== undefined ? `Gas limit: ${ctx.gas}` : undefined,
    ctx.maxFee !== undefined ? `Max network fee: ${formatNative(ctx.maxFee)} ${ctx.nativeSymbol}` : undefined,
    `Data: ${data}`,
  ]
    .filter((line): line is string => !!line)
    .join("\n");

  return { title, body: lines.join("\n"), details };
}

const KEY_MESSAGE_PREFIX = "NadBounty contest encryption key";

/** personal_sign. `messageHex` is the 0x-prefixed payload the wallet receives. */
export function describeMessageSignature(messageHex: string, ctx: SigningContext): ConfirmCopy {
  let text: string | undefined;
  try {
    const decoded = hexToString(messageHex as Hex);
    // Printable text only; binary payloads are shown as hex in the details.
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(decoded)) text = decoded;
  } catch {
    text = undefined;
  }
  const details = [
    ctx.from ? `Signer: ${ctx.from}` : undefined,
    text !== undefined ? `Message:\n${text}` : `Message (hex): ${messageHex}`,
  ]
    .filter((line): line is string => !!line)
    .join("\n");

  if (text?.startsWith(KEY_MESSAGE_PREFIX)) {
    return {
      title: "Unlock your contest encryption key",
      body: "Sign to unlock your contest encryption key. This signature does not move funds.",
      details,
    };
  }
  const firstLine = text?.split("\n")[0].trim().slice(0, 60);
  return {
    title: "Sign a message",
    body: [
      `Your passkey wallet will sign a message on ${ctx.chainName}.`,
      firstLine ? `It starts with: "${firstLine}"` : "It is not readable text.",
      "Signing a message does not send a transaction or spend funds on its own.",
    ].join("\n"),
    details,
  };
}

const MONEY_TYPES = /permit|approv|transfer|order|delegat|withdraw|allowance/i;

/** eth_signTypedData_v4. */
export function describeTypedDataSignature(typed: unknown, ctx: SigningContext): ConfirmCopy {
  const data = (typed ?? {}) as { primaryType?: unknown; domain?: { name?: unknown } };
  const primary =
    typeof data.primaryType === "string" && /^[A-Za-z0-9_]{1,40}$/.test(data.primaryType)
      ? data.primaryType
      : undefined;
  const domainName =
    typeof data.domain?.name === "string" ? data.domain.name.replace(/[^\w .-]/g, "").slice(0, 40) : "";
  const body = [
    `Your passkey wallet will sign structured data on ${ctx.chainName}${domainName ? ` for "${domainName}"` : ""}.`,
    primary && MONEY_TYPES.test(primary)
      ? "This kind of signature can let someone else move your tokens. Open the technical details and check it first."
      : "Open the technical details to see exactly what is being signed.",
  ].join("\n");
  const details = [ctx.from ? `Signer: ${ctx.from}` : undefined, plain(typed, 2)].filter(Boolean).join("\n");
  return { title: primary ? `Sign a ${primary} request` : "Sign structured data", body, details };
}
