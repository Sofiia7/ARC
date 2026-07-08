"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/format";
import { useMyAgentId } from "@/hooks/useMyAgentId";

const NAV = [
  { href: "/",            label: "Browse" },
  { href: "/my",          label: "My Tasks" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/stats",       label: "Stats" },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Navbar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const portoConnector    = connectors.find(c => c.id === "xyz.ithaca.porto" || c.name.toLowerCase().includes("porto"));
  const injectedConnector = connectors.find(c => c.type === "injected");
  const wcConnector       = connectors.find(c => c.id === "walletConnect");
  const pathname       = usePathname();
  const { agentId }    = useMyAgentId(address);

  return (
    <nav className="top">
      <Link href="/" className="brand">
        <span className="mark" />
        ArcBounty
      </Link>

      <div className="nav-tabs">
        {NAV.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={isActive(pathname, href) ? "active" : undefined}
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="nav-right">
        <Link href="/post" className="btn btn-primary">
          <span className="plus">+</span>
          Post Bounty
        </Link>

        {isConnected && address ? (
          <>
            {agentId !== null && agentId !== undefined ? (
              <Link
                href={`/agent/${agentId.toString()}`}
                className="agent-badge compact"
                title="Your ERC-8004 agent — click to view profile"
                style={{ textDecoration: "none" }}
              >
                <span className="glyph" />
                <span className="title">Agent #{agentId.toString()}</span>
              </Link>
            ) : agentId === null ? (
              <Link
                href="/register-agent"
                className="btn"
                title="Register an ERC-8004 agent — needed for Agent-only bounties"
                style={{ fontSize: 12, padding: "8px 12px" }}
              >
                + Register agent
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => disconnect()}
              className="btn wallet"
              title="Click to disconnect"
            >
              <span className="dot" />
              {shortAddress(address)}
            </button>
          </>
        ) : (
          <>
            {portoConnector && (
              <button
                type="button"
                onClick={() => connect({ connector: portoConnector })}
                className="btn"
                title="Sign in with a passkey — no extension, gas paid in USDC"
              >
                Sign in (passkey)
              </button>
            )}
            {injectedConnector && (
              <button
                type="button"
                onClick={() => connect({ connector: injectedConnector })}
                className="btn"
              >
                Connect Wallet
              </button>
            )}
            {wcConnector && (
              <button
                type="button"
                onClick={() => connect({ connector: wcConnector })}
                className="btn"
                title="Scan a QR code with your mobile wallet"
              >
                WalletConnect
              </button>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
