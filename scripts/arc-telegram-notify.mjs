/**
 * Telegram alerts for ArcBounty on Arc mainnet. .github/workflows/arc-telegram-notify.yml
 * runs this every 10 minutes: new bounties, takes, submitted work (the event a
 * human has to act on, with the payout command), rejections, disputes, payouts.
 *
 * Why it exists: on launch day an outside agent delivered four jobs, posted a
 * bounty asking a human to chase us for the payout twenty minutes after its first
 * delivery, and was paid nine hours later, when we woke up.
 *
 * State is one number, the last block already reported, kept in STATE_FILE
 * between runs (the workflow carries it in the Actions cache). With no state the
 * run starts ~25 minutes back, so history is never replayed into the chat.
 *
 * Env: TG_BOT_TOKEN and TG_BOT_CHAT (without them it reports nothing and keeps
 * its state), STATE_FILE (default .notify-state/state.json), ARC_MAINNET_RPC_URL.
 *
 * Local dry run, prints instead of sending and saves no state:
 *   node scripts/arc-telegram-notify.mjs --dry-run --from-block 21153190
 */
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ADAPTER = "0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D";
const OUR_POSTER = "0xde427f3967cc7a0bf7a9f891195760ccffc82eda";
const RPC = process.env.ARC_MAINNET_RPC_URL || "https://rpc.blockdaemon.mainnet.arc.io";
const SITE = "https://arcbounty.app";
const TX = "https://arcexplorer.org/tx/";
const GATEWAYS = ["https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/"];
const APPROVAL_TIMEOUT_S = 14 * 86_400;
const CHUNK = 90_000n; // Blockdaemon serves eth_getLogs up to 100k blocks
const FIRST_RUN_LOOKBACK = 3_000n; // ~25 minutes at ~2 blocks a second
const MAX_CATCH_UP = 360_000n; // ~2 days; a longer gap is skipped with a note
const PAY_COMMAND = "cd /d C:\\Server\\ARC\\scripts && npx tsx review-mainnet-submissions.ts";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const fromArg = args.includes("--from-block") ? BigInt(args[args.indexOf("--from-block") + 1]) : null;
const STATE_FILE = process.env.STATE_FILE || ".notify-state/state.json";
const TOKEN = process.env.TG_BOT_TOKEN?.trim();
const CHAT = process.env.TG_BOT_CHAT?.trim();

const EVENTS = parseAbi([
  "event BountyCreated(uint256 indexed jobId, address indexed poster, uint256 reward, string category, uint256 deadline)",
  "event BountyTaken(uint256 indexed jobId, address indexed provider, uint256 agentId)",
  "event WorkSubmitted(uint256 indexed jobId, address indexed provider, string ipfsResultHash)",
  "event BountyCompleted(uint256 indexed jobId, uint256 agentId, uint256 reputationScore)",
  "event BountyAutoApproved(uint256 indexed jobId, address indexed provider)",
  "event BountyCancelled(uint256 indexed jobId, string reason)",
  "event BountyExpired(uint256 indexed jobId)",
  "event RejectionProposed(uint256 indexed jobId, address indexed poster, string reasonHash)",
  "event RejectionChallenged(uint256 indexed jobId, address indexed worker, string reasonHash)",
  "event DisputeRaised(uint256 indexed jobId, address indexed initiator, string reasonHash)",
  "event DisputeResolved(uint256 indexed jobId, bool payProvider, string rulingHash, bool defaultRuling)",
  "event PayoutParked(uint256 indexed jobId, address indexed payee, uint256 amount)",
]);
const META_ABI = [{
  type: "function", name: "bounties", stateMutability: "view", inputs: [{ type: "uint256" }],
  outputs: [{ type: "tuple", components: [
    { name: "jobId", type: "uint256" }, { name: "poster", type: "address" }, { name: "reward", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "ipfsDescHash", type: "string" }, { name: "category", type: "string" },
    { name: "tags", type: "string[]" }, { name: "agentId", type: "uint256" }, { name: "agentOnly", type: "bool" },
    { name: "humanOnly", type: "bool" }, { name: "whitelistedProvider", type: "address" }, { name: "assignedProvider", type: "address" },
    { name: "submittedResultHash", type: "string" }, { name: "submittedAt", type: "uint256" }, { name: "isTaken", type: "bool" },
    { name: "rejectedAt", type: "uint256" }, { name: "rejectionReasonHash", type: "string" }, { name: "inDispute", type: "bool" },
    { name: "resolved", type: "bool" }, { name: "disputeInitiator", type: "address" }, { name: "disputeRaisedAt", type: "uint256" },
    { name: "disputeReasonHash", type: "string" }, { name: "disputeResponseHash", type: "string" },
    { name: "disputeRulingHash", type: "string" }, { name: "requireWorkerBond", type: "bool" }, { name: "workerBond", type: "uint256" },
  ] }],
}];

const pub = createPublicClient({ transport: http(RPC, { retryCount: 3 }) });
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usdc = v => formatUnits(v, 6);
const utc = seconds => new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const gateway = uri => (uri?.startsWith("ipfs://") ? GATEWAYS[0] + uri.slice(7) : uri);

async function ipfsTitle(uri) {
  if (!uri?.startsWith("ipfs://")) return null;
  for (const g of GATEWAYS) {
    try {
      const res = await fetch(g + uri.slice(7), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const line = (await res.text()).split(/\r?\n/).find(l => l.trim());
      return line ? line.replace(/^#+\s*/, "").trim().slice(0, 120) : null;
    } catch {
      // next gateway
    }
  }
  return null;
}

const metaCache = new Map();
async function bounty(jobId) {
  const key = jobId.toString();
  if (!metaCache.has(key)) {
    const meta = await pub.readContract({ address: ADAPTER, abi: META_ABI, functionName: "bounties", args: [jobId] });
    metaCache.set(key, { meta, title: await ipfsTitle(meta.ipfsDescHash) });
  }
  return metaCache.get(key);
}

async function render(log) {
  const a = log.args;
  const { meta, title } = await bounty(a.jobId);
  const head = `<b>#${a.jobId}</b> ${esc(title ?? meta.category)} (${usdc(meta.reward)} USDC)`;
  const page = `${SITE}/bounty/${a.jobId}`;
  const tx = `<a href="${TX}${log.transactionHash}">tx</a>`;
  const worker = who => `${short(who)}${meta.agentId > 0n ? `, агент #${meta.agentId}` : ""}`;
  switch (log.eventName) {
    case "BountyCreated":
      return `🆕 Новое баунти ${head}\nразместил ${a.poster.toLowerCase() === OUR_POSTER ? "наш кошелёк" : short(a.poster)}\n${page} · ${tx}`;
    case "BountyTaken":
      return `🤝 Взяли ${head}\nисполнитель ${short(a.provider)}${a.agentId > 0n ? `, агент #${a.agentId}` : ""}\n${page} · ${tx}`;
    case "WorkSubmitted": {
      // The payout hint only while it is still ours to pay: a catch-up run can meet a paid one.
      const ours = meta.poster.toLowerCase() === OUR_POSTER && !meta.resolved;
      const opens = Number(meta.submittedAt) + APPROVAL_TIMEOUT_S;
      return `📥 Сдали работу ${head}\nисполнитель ${worker(a.provider)}\nработа: ${esc(gateway(a.ipfsResultHash))}\n${page} · ${tx}` +
        (ours ? `\n\nпроверить и оплатить:\n<code>${esc(PAY_COMMAND)}</code>\nавтоодобрение откроется ${utc(opens)}` : "");
    }
    case "BountyCompleted":
      return `✅ Одобрено и выплачено ${head}${a.agentId > 0n ? `\nоценка агенту #${a.agentId}: ${a.reputationScore}` : ""}\n${tx}`;
    case "BountyAutoApproved":
      return `✅ Автоодобрение ${head}, выплата ${short(a.provider)}\n${tx}`;
    case "BountyCancelled":
      return `🚫 Отменено ${head}\n${esc(a.reason)} · ${tx}`;
    case "BountyExpired":
      return `⌛ Истекло ${head}\n${tx}`;
    case "RejectionProposed":
      return `⚠️ Постер отклонил работу ${head}\nу исполнителя 48 часов на оспаривание\n${page} · ${tx}`;
    case "RejectionChallenged":
      return `⚠️ Исполнитель оспорил отказ ${head}, теперь это спор\n${page} · ${tx}`;
    case "DisputeRaised":
      return `⚠️ Открыт спор ${head}\nинициатор ${short(a.initiator)}\n${page} · ${tx}`;
    case "DisputeResolved":
      return `⚖️ Спор решён ${head}: ${a.payProvider ? "в пользу исполнителя" : "в пользу постера"}${a.defaultRuling ? " (по умолчанию)" : ""}\n${tx}`;
    case "PayoutParked":
      return `🅿️ Выплата ${usdc(a.amount)} USDC по ${head} припаркована для ${short(a.payee)}: заберёт через withdraw()\n${tx}`;
    default:
      return null;
  }
}

async function send(text) {
  if (DRY_RUN) {
    console.log(`--- would send ---\n${text}\n`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Telegram answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  if (!DRY_RUN && (!TOKEN || !CHAT)) {
    console.log("::warning::TG_BOT_TOKEN / TG_BOT_CHAT are not set - nothing sent, state kept");
    return;
  }
  const head = await pub.getBlockNumber();
  const saved = existsSync(STATE_FILE) ? BigInt(JSON.parse(readFileSync(STATE_FILE, "utf8")).lastBlock) : null;
  let from = fromArg ?? (saved !== null ? saved + 1n : head - FIRST_RUN_LOOKBACK);
  const notes = [];
  if (head - from > MAX_CATCH_UP) {
    notes.push(`ℹ️ Уведомления не работали с блока ${from}; события старше последних ~2 суток пропущены, смотри ${SITE}`);
    from = head - MAX_CATCH_UP;
  }
  if (from > head) {
    console.log(`nothing new: head ${head}, last reported ${saved}`);
    return;
  }

  const logs = [];
  for (let start = from; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
    logs.push(...(await pub.getLogs({ address: ADAPTER, events: EVENTS, fromBlock: start, toBlock: end })));
  }
  logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber)));
  console.log(`blocks ${from}..${head}: ${logs.length} event(s)`);

  for (const note of notes) await send(note);
  for (const log of logs) {
    const text = await render(log);
    if (text) await send(text);
  }
  if (!DRY_RUN) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ lastBlock: head.toString(), at: new Date().toISOString() }));
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
