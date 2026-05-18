"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { shortAddress } from "@/lib/format";

const NAV = [
  { href: "/",            label: "Browse" },
  { href: "/my",          label: "My Tasks" },
  { href: "/leaderboard", label: "Leaderboard" },
];

export function Navbar() {
  const { address, isConnected } = useAccount();
  const { connect }    = useConnect();
  const { disconnect } = useDisconnect();
  const pathname       = usePathname();

  return (
    <nav
      className="sticky top-0 z-50 border-b border-white/5"
      style={{
        background: "rgba(7, 8, 13, 0.65)",
        backdropFilter: "blur(20px) saturate(140%)",
        WebkitBackdropFilter: "blur(20px) saturate(140%)",
      }}
    >
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-bold text-xl tracking-tight shrink-0 flex items-center gap-2">
            <span className="text-gradient">Arc</span>
            <span className="text-white">Bounty</span>
          </Link>
          <div className="flex items-center gap-1">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm transition-all
                  ${pathname === href
                    ? "bg-white/10 text-white border border-white/10"
                    : "text-gray-400 hover:text-white hover:bg-white/5"
                  }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link href="/post" className="btn-glow text-sm !py-2 !px-4">
            + Post Bounty
          </Link>

          {isConnected && address ? (
            <button onClick={() => disconnect()} className="btn-ghost text-sm font-mono !py-2 !px-3">
              {shortAddress(address)}
            </button>
          ) : (
            <button onClick={() => connect({ connector: injected() })} className="btn-ghost text-sm !py-2 !px-4">
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
