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
    <nav className="border-b border-gray-800 bg-gray-950/90 backdrop-blur sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Left: logo + links */}
        <div className="flex items-center gap-6">
          <Link href="/" className="font-bold text-lg text-white tracking-tight shrink-0">
            ArcBounty
          </Link>
          <div className="flex items-center gap-1">
            {NAV.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm transition-colors
                  ${pathname === href
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800/50"
                  }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        {/* Right: post button + wallet */}
        <div className="flex items-center gap-3">
          <Link
            href="/post"
            className="text-sm bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded-lg transition-colors font-semibold"
          >
            + Post Bounty
          </Link>

          {isConnected && address ? (
            <button
              onClick={() => disconnect()}
              className="text-sm bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition-colors font-mono border border-gray-700"
            >
              {shortAddress(address)}
            </button>
          ) : (
            <button
              onClick={() => connect({ connector: injected() })}
              className="text-sm bg-gray-800 hover:bg-gray-700 px-4 py-1.5 rounded-lg transition-colors border border-gray-700"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
