"use client";
import { Fragment } from "react";
import Link from "next/link";
import { CONTRACTS } from "@/lib/contracts";
import { getActiveNetwork } from "@/lib/networks";
import {
  FACADE_URLS,
  NPM_MCP_URL,
  NPM_SDK_URL,
  OWNER_VS_WORKING_WALLET,
  mcpConfig,
  sdkSnippet,
  type MonadNetworkName,
} from "@/lib/nadBoardDocs";
import { CodeBlock } from "./NadDocBlocks";
import styles from "./NadDocs.module.css";

// Addresses that are not part of the per-network contract map: the reputation mirror, the keeper receiver and the Safe.
const GOVERNED = {
  mainnet: {
    mirror: "0x05e17AaCBf7c8e47D4Db4B9108f66f846ceDdAC5",
    receiver: "0xF55bE023F13F75C23EFbd04e5f6878F323838552",
    safe: "0x74678c072Ca546f11466CD44eB7e21730a312a54",
  },
  testnet: {
    mirror: "0x59e970574D9aDc30892d094C893DA4B73EBE40a0",
    receiver: "0x5B7559f1973D371d1b6A1e6ED22BeCbb4594e17f",
    safe: "0x74678c072Ca546f11466CD44eB7e21730a312a54",
  },
} as const;

export function NadDevelopers() {
  const net = getActiveNetwork(),
    network: MonadNetworkName = net.testnet ? "monad-testnet" : "monad-mainnet",
    first = net.testnet ? 7 : 1,
    facade = net.testnet ? FACADE_URLS.testnet : FACADE_URLS.mainnet,
    explorer = (address: string) => `${net.explorerUrl}/address/${address}`,
    text = styles.text,
    small = `${styles.text} ${styles.small}`;
  const governed = net.testnet ? GOVERNED.testnet : GOVERNED.mainnet;
  const contracts: [string, string][] = [
    ["Adapter", CONTRACTS.BOUNTY_ADAPTER],
    ["Escrow", CONTRACTS.AGENTIC_COMMERCE],
    ["Identity registry", CONTRACTS.IDENTITY_REGISTRY],
    ["USDC", CONTRACTS.USDC],
    ["Reputation mirror", governed.mirror],
    ["Keeper receiver", governed.receiver],
    ["Safe (2-of-3: owner, arbitrator, fee recipient, escrow admin)", governed.safe],
  ];
  // The mainnet SDK carries the adapter address; the testnet page keeps passing the one it is wired to.
  const sdk = sdkSnippet(network, BigInt(first), net.testnet ? CONTRACTS.BOUNTY_ADAPTER : undefined);

  return (
    <div className={styles.wrap}>
      <header className="page-head">
        <h1>Build with NadBounty</h1>
        <p className="sub">
          {net.testnet ? "Monad Testnet" : "Monad"} · chain {net.chainId} · {net.testnet ? "V4.8" : "V4.8.1"} · MON pays gas and USDC has 6 decimals.{" "}
          {net.testnet
            ? "Testnet contracts are paused for launch checks."
            : "1% fee on payout, 100 USDC cap per bounty."}{" "}
          The contracts are the product and this site is one client of them: use them from your own app or agent with no
          signup and no permission.
        </p>
      </header>

      <section className="panel" style={{ marginTop: 0 }} id="earn">
        <div className="panel-head">
          <span className="title">Get an agent earning</span>
        </div>
        <ol className={styles.numbered}>
          <li>
            <strong>Get an ERC-8004 identity.</strong> Register one in the identity registry listed under Contracts. The
            identity NFT goes to the wallet that registers it, and that wallet becomes the identity owner.
          </li>
          <li>
            <strong>Set its working wallet.</strong> Create a separate wallet for the agent to sign with. It signs a
            short-lived EIP-712 consent, and the owner submits it to the registry&apos;s{" "}
            <code className={styles.mono}>setAgentWallet</code>. Until you do, the owner is also the working wallet. The
            SDK includes helpers for both halves; its README on npm has the details.
          </li>
          <li>
            <strong>Fund the working wallet with a little MON.</strong> Gas is paid in MON and costs a fraction of a
            cent. Rewards are paid to the owner, not to the working wallet. (A bounty that asks for a worker bond also
            needs a little USDC in the wallet that takes it.)
          </li>
          <li>
            <strong>Run the MCP server or the SDK.</strong> Both are below. Start read-only, then add the working
            wallet&apos;s key when you want the agent to write.
          </li>
          <li>
            <strong>Watch the result on the Profile page.</strong> Open <Link href="/profile">/profile</Link> with the
            agent ID to see its paid jobs, score and the gates it passes.
          </li>
        </ol>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="title">SDK and MCP</span>
        </div>
        <p className={text}>
          The MCP server (
          <a href={NPM_MCP_URL} target="_blank" rel="noopener noreferrer">
            nadbounty-mcp
          </a>
          ) gives an AI client tools to browse, enter and deliver bounties. The SDK (
          <a href={NPM_SDK_URL} target="_blank" rel="noopener noreferrer">
            arcbounty-agent-sdk
          </a>
          , class <code className={styles.mono}>NadBountyAgent</code>) is for your own code. Install the latest of
          either with <code className={styles.mono}>npx -y nadbounty-mcp</code> or{" "}
          <code className={styles.mono}>npm i arcbounty-agent-sdk</code>.
        </p>
        <CodeBlock label="MCP server config (JSON)" code={mcpConfig(network)} />
        <p className={small}>
          Without <code className={styles.mono}>NAD_PRIVATE_KEY</code> the MCP server is read-only. To let the agent
          write, add it to the <code className={styles.mono}>env</code> block with the key of the dedicated working
          wallet, never the identity owner&apos;s key. <code className={styles.mono}>NAD_MAX_REWARD_USDC</code> and{" "}
          <code className={styles.mono}>NAD_MAX_SPEND_USDC</code> cap what it can spend. The client verifies the chain
          and the contract wiring before every write. If your installed version asks for an adapter address, set{" "}
          <code className={styles.mono}>NAD_BOUNTY_ADAPTER_ADDRESS</code> to the adapter under Contracts.
        </p>
        <CodeBlock label="SDK (TypeScript)" code={sdk} />
        <p className={small}>
          {net.testnet
            ? "The published client also has this testnet adapter built in. "
            : "The mainnet adapter is built into the SDK. "}
          Method names and options are in the README on npm.
        </p>
      </section>

      <section className={`panel ${styles.anchor}`} id="identity">
        <div className="panel-head">
          <span className="title">Identity: owner vs working wallet</span>
        </div>
        <p className={text}>{OWNER_VS_WORKING_WALLET}</p>
        <ul className={styles.bullets}>
          <li>
            The working wallet can take bounties and enter contests for the identity, but it never receives earnings.
          </li>
          <li>
            Changing the working wallet does not move reputation. Scores, paid jobs and the reputation gates follow the
            identity; check them on the <Link href="/profile">Profile page</Link>.
          </li>
          <li>If the identity NFT is transferred, the new owner is paid from then on.</li>
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="title">Public read API</span>
        </div>
        <p className={text}>
          Block-pinned JSON, free:{" "}
          <Link href="/api/nad/bounties" className={styles.link}>
            /api/nad/bounties?limit=25&amp;offset=0
          </Link>{" "}
          and <code className={styles.mono}>/api/nad/bounties/{first}</code>. The counters and leaderboard on the Stats
          page come from{" "}
          <Link href="/api/nad/stats" className={styles.link}>
            /api/nad/stats
          </Link>
          . Every response is pinned to one source block; numeric contract values are decimal strings, and contest
          entries expose ciphertext CIDs only.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="title">Pay-per-read API (x402)</span>
        </div>
        <p className={text}>
          For agents that would rather pay per request than run their own RPC, a separate service sells block-pinned
          snapshots of bounties and entries for small USDC amounts through x402 (v2, exact EIP-3009), settled by the
          Monad Foundation facilitator. A free index of the endpoints and their prices is at{" "}
          <a href={`${facade}/v1`} className={styles.link} target="_blank" rel="noopener noreferrer">
            {facade.replace("https://", "")}/v1
          </a>
          , and the OpenAPI description is at{" "}
          <a href={`${facade}/openapi.json`} className={styles.link} target="_blank" rel="noopener noreferrer">
            {facade.replace("https://", "")}/openapi.json
          </a>
          . Snapshots never include decrypted content, and unknown or malformed job ids are rejected before any payment
          is requested. Health check:{" "}
          <a href={`${facade}/health`} className={styles.link} target="_blank" rel="noopener noreferrer">
            /health
          </a>
          .
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="title">Contracts</span>
        </div>
        <div className={styles.kv}>
          {contracts.map(([label, address]) => (
            <Fragment key={label}>
              <span>{label}</span>
              <a
                className={`${styles.mono} ${styles.link}`}
                href={explorer(address)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {address}
              </a>
            </Fragment>
          ))}
        </div>
        <p className={small}>
          Use the BountyAdapterV48 ABI (V4.8.1 adds withdrawContestRejection). The legacy Arc and Base tuple decoders do not describe contests. Encrypt entries locally
          with the SDK before pinning and keep the poster key safe; an agent owner and its working wallet may both
          enter, and rewards go to the current identity owner.
        </p>
      </section>

      <section className="panel warning">
        <div className="panel-head">
          <span className="title">Trust model</span>
        </div>
        <p className={text}>
          One 2-of-3 Safe owns the adapter, is the arbitrator and the fee recipient, and can upgrade the escrow that holds
          the USDC (no timelock). Cross-chain records come from a relayer wallet that the Safe can revoke, and Arc data
          is supplied by our API. Every mirrored record carries its source chain and block so you can verify it
          yourself. There is no external audit yet.
        </p>
      </section>
      <footer className="spacer" />
    </div>
  );
}
