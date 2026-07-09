"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useDisconnect } from "wagmi";
import { shortAddress } from "@/lib/format";
import { useMyAgentId } from "@/hooks/useMyAgentId";
import { ConnectWalletModal } from "@/components/ConnectWalletModal";
import { NotificationBell } from "@/components/NotificationBell";

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
  const { disconnect } = useDisconnect();
  const [showConnectModal, setShowConnectModal] = useState(false);

  const pathname       = usePathname();
  const { agentId }    = useMyAgentId(address);

  return (
    <>
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
              <NotificationBell />
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
            <button type="button" onClick={() => setShowConnectModal(true)} className="btn btn-primary">
              Connect Wallet
            </button>
          )}
        </div>
      </nav>

      {showConnectModal && !isConnected && (
        <ConnectWalletModal onClose={() => setShowConnectModal(false)} />
      )}
    </>
  );
}
