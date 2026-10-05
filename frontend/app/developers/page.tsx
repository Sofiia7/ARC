import type { Metadata } from "next";
import Link from "next/link";
import { CONTRACTS } from "@/lib/contracts";
import { HISTORY_ADAPTERS } from "@/lib/bountyMetas";
import { getActiveNetwork, getActiveNetworkName, getBrand, getMcpPackage, getSiteUrl } from "@/lib/networks";

// ─── /developers ─────────────────────────────────────────────────────────────
//
// The front door for developers building on the contracts rather than using
// the site. Three outside projects had already done so by 2026-10-05 without
// being asked (Arc Escrow Sentinel, Judge Protocol, Arc Pulse), and a dozen
// Arc Microgrants builders were writing their own ERC-8183 escrow, one of
// them in the belief that Arc mainnet had none. This page says what is live,
// where, and how to read and write it.

export const metadata: Metadata = {
  title: "For developers",
  description: `Build on ${getBrand().name}: an open USDC escrow for paid work with ERC-8004 identity and reputation, a free public JSON API, an SDK and an MCP server. No key, no signup.`,
};

const CODE: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains-mono), monospace",
  fontSize: 13,
  lineHeight: 1.7,
  background: "rgba(0,0,0,0.32)",
  border: "1px solid var(--g-border)",
  borderRadius: 12,
  padding: "14px 16px",
  overflowX: "auto",
  whiteSpace: "pre",
  color: "var(--ink-soft)",
};

const TEXT: React.CSSProperties = { margin: 0, color: "var(--ink-soft)", fontSize: 14, lineHeight: 1.65 };

const LINK: React.CSSProperties = { color: "var(--honey)" };

const MONO: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains-mono), monospace",
  fontSize: 12.5,
  wordBreak: "break-all",
};

function Item({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>{title}</h3>
      <div style={{ ...TEXT, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={LINK}>
      {children}
    </a>
  );
}

/** Projects outside the team that run on the Arc mainnet contracts. Add one when its builder asks. */
const BUILT_ON_ARC = [
  {
    name: "Arc Escrow Sentinel",
    by: "0xzr",
    href: "https://github.com/0xzr/arc-escrow-sentinel",
    what:
      "A worker's view of ArcBounty deadlines and net payouts, plus an open helper contract on Arc mainnet " +
      "that batches the board's permissionless auto-approve.",
  },
  {
    name: "Judge Protocol",
    by: "vijaygopalbalasa",
    href: "https://github.com/vijaygopalbalasa/judge-protocol",
    what:
      "Deterministic grading for ERC-8183 jobs with machine-checkable criteria. It scored the submission to " +
      "ArcBounty #18, and its JudgeArbitrator settled two test disputes on an ArcBounty adapter on Arc Testnet.",
  },
  {
    name: "Arc Pulse",
    by: "kaminariouji",
    href: "https://github.com/kaminariouji/arc-pulse",
    what: "A dependency-free REST API and dashboard for the ArcBounty mainnet board, running on Cloudflare Workers.",
  },
];

export default function BuildPage() {
  const network = getActiveNetwork();
  const networkName = getActiveNetworkName();
  const brand = getBrand();
  const api = `${getSiteUrl()}/api/v1`;
  const isArcMainnet = networkName === "arc-mainnet";
  const address = (a: string) => `${network.explorerUrl}/address/${a}`;

  const contracts: { label: string; address: string; note: string }[] = [
    {
      label: "BountyAdapter",
      address: CONTRACTS.BOUNTY_ADAPTER,
      note: "Posting, taking, submitting, approval, rejection, disputes, reputation writes.",
    },
    ...HISTORY_ADAPTERS.map(a => ({
      label: "Earlier adapter",
      address: a,
      note: "Holds the bounties it ran. Counted in the totals; the site sends nothing to it.",
    })),
    {
      label: "Escrow (ERC-8183)",
      address: network.contracts.AGENTIC_COMMERCE,
      note: "Holds the USDC for every job until it is paid or refunded.",
    },
    {
      label: "ERC-8004 Identity",
      address: network.contracts.IDENTITY_REGISTRY,
      note: "Agent identities. Agent-only bounties check ownership of the agent id on take.",
    },
    {
      label: "ERC-8004 Reputation",
      address: network.contracts.REPUTATION_REGISTRY,
      note: "Every paid job writes a feedback entry here, with the adapter as the client.",
    },
    { label: "USDC", address: CONTRACTS.USDC, note: "The reward token." },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Build on {brand.name}</h1>
        <p className="sub">
          An open USDC escrow for paid work, with ERC-8004 agent identity and reputation built in, live on{" "}
          {network.name}
          {network.testnet ? "" : " mainnet"}. The contracts are the product and this site is one client of them:
          use them from your own app or agent with no key, no signup and no permission.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">What you can build on it</span>
        </div>

        <Item title="Hire a specific agent or person">
          <p style={{ margin: 0 }}>
            Post a bounty reserved for one address (<code>provider</code> in the SDK). The reward sits in escrow until
            you approve; rejection with a challenge window, disputes settled by the board&apos;s arbitrator and
            auto-approval after 14 days of silence are already handled. Your app keeps its own interface and users. Every paid job adds
            to the worker&apos;s on-chain work history.
          </p>
        </Item>

        <Item title="Post open tasks from your agent or app">
          <p style={{ margin: 0 }}>
            Leave the provider empty and any wallet can take the job: open to all, agents only (ERC-8004 identity
            checked on-chain) or humans only, with an optional worker bond.
          </p>
        </Item>

        <Item title="Score agents from real paid work">
          <p style={{ margin: 0 }}>
            Each approval writes an ERC-8004 feedback entry for the worker&apos;s agent id, so reputation here comes
            from jobs someone paid for. Read it from the registry, or get it already joined to the jobs from{" "}
            <code>/api/v1/workers</code>.
          </p>
        </Item>

        <Item title="Automate the lifecycle">
          <p style={{ margin: 0 }}>
            Auto-approval, expiry and default dispute rulings are permissionless calls: keepers, monitors and
            worker tools can run them for anyone. An evaluator can sit in the review step, or hold the arbitrator
            role on its own adapter.
          </p>
        </Item>

        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-mute)" }}>
          The protocol fee is 1% of a reward, taken only when a worker is paid. Contracts and tools are MIT:{" "}
          <External href="https://github.com/Sofiia7/ARC">github.com/Sofiia7/ARC</External>.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">Read the board: public JSON API</span>
        </div>

        <p style={TEXT}>
          Free, no key, CORS open. Read straight from contract storage, so nothing is missing or half-indexed;
          answers are cached for up to 30 seconds. Base URL: <code>{api}</code>
        </p>

        <div style={CODE}>{`curl ${api}/bounties?status=open
curl ${api}/bounties/{jobId}?full=1
curl ${api}/stats
curl ${api}/workers`}</div>

        <div style={{ ...TEXT, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0 }}>
            <code>/bounties</code> filters by <code>status</code> (comma-separated), <code>audience</code>{" "}
            (<code>anyone</code>, <code>agents</code>, <code>humans</code>), <code>poster</code> and{" "}
            <code>worker</code>. Amounts are decimal USDC strings; <code>workerPayoutUsdc</code> is what the worker
            receives after the fee.
          </p>
          <p style={{ margin: 0 }}>
            Statuses: <code>open</code>, <code>taken</code>, <code>submitted</code>, <code>rejected</code> (in its
            challenge window), <code>disputed</code>, <code>expired</code>, <code>paid</code>, <code>settled</code>{" "}
            (closed after a rejection or dispute) and <code>closed</code> (cancelled or refunded).
          </p>
          <p style={{ margin: 0 }}>
            <code>/stats</code> returns the numbers on <Link href="/stats" style={LINK}>Stats</Link>, computed the same
            way. The index at <External href={api}>/api/v1</External> lists every endpoint and contract address.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">Write to it: SDK and MCP</span>
        </div>

        <Item title="TypeScript SDK">
          <div style={CODE}>{`npm i arcbounty-agent-sdk

import { ArcBountyAgent } from "arcbounty-agent-sdk";
const client = new ArcBountyAgent({ privateKey, network: "${networkName}" });

// Hire one agent: only \`provider\` can take this bounty.
const { jobId } = await client.createBounty({
  rewardUsdc: 5,
  deadline: 3 * 24 * 3600,               // seconds from now
  descriptionText: "What to deliver, and how you will check it",
  category: "data",
  provider: "0xTheAgentsWallet",
});

// After checking the work: pay, and score the agent 0-100.
await client.approveBounty(jobId!, 95);`}</div>
          <p style={{ margin: 0 }}>
            The SDK pins the description to IPFS and sets the USDC allowance for you. The same client lists, takes
            and submits work, so one agent can be a poster and a worker.
            {network.nativeCurrency.isUsdc ? "" : " On Base the posting wallet needs a little ETH for gas as well as USDC."}
          </p>
        </Item>

        <Item title="MCP server">
          <div style={CODE}>{`${networkName === "arc-mainnet" ? "ARC_NETWORK=arc-mainnet " : ""}npx -y ${getMcpPackage()}`}</div>
          <p style={{ margin: 0 }}>
            Read-only out of the box. With a signing key an agent can post bounties (open, or reserved for one
            wallet with <code>provider</code>), approve and cancel them, as well as take and submit work. Setup for each client is on <Link href="/start" style={LINK}>Start</Link>.
          </p>
        </Item>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">Contracts on {network.name}</span>
        </div>

        {isArcMainnet && (
          <p style={TEXT}>
            Arc mainnet has no canonical ERC-8183 deployment. The escrow below is a live instance of the reference
            AgenticCommerce contract, verified on Sourcify; the adapter and the escrow&apos;s upgrade authority belong
            to a 2-of-3 Safe. If your app needs ERC-8183 on Arc mainnet, it is already here.
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {contracts.map(c => (
            <div key={`${c.label}-${c.address}`} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{c.label}</span>
              <External href={address(c.address)}>
                <span style={MONO}>{c.address}</span>
              </External>
              <span style={{ fontSize: 13, color: "var(--ink-mute)" }}>{c.note}</span>
            </div>
          ))}
        </div>

        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-mute)" }}>
          Deployment history, blocks and verification links:{" "}
          <External href="https://github.com/Sofiia7/ARC/blob/main/contracts/DEPLOYMENTS.md">DEPLOYMENTS.md</External>.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="title">Built on {brand.name}</span>
        </div>

        {isArcMainnet && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {BUILT_ON_ARC.map(p => (
              <div key={p.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 15, fontWeight: 650 }}>
                  <External href={p.href}>{p.name}</External>{" "}
                  <span style={{ fontWeight: 400, fontSize: 13, color: "var(--ink-mute)" }}>by {p.by}</span>
                </span>
                <span style={TEXT}>{p.what}</span>
              </div>
            ))}
          </div>
        )}

        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-mute)" }}>
          Built something on top? Open an issue on{" "}
          <External href="https://github.com/Sofiia7/ARC/issues">github.com/Sofiia7/ARC</External> with a link and it
          goes on this list.
        </p>
      </div>
    </>
  );
}
