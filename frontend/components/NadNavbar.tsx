"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";
import { getBrand } from "@/lib/networks";
import { ConnectWalletModal } from "./ConnectWalletModal";
import { WalletMenu } from "./WalletMenu";

const NAV = [
  { href: "/", label: "Browse" },
  { href: "/my", label: "My Tasks" },
  { href: "/profile", label: "Profile" },
  { href: "/stats", label: "Stats" },
  { href: "/developers", label: "Developers" },
];
function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/" || pathname.startsWith("/bounty/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NadNavbar() {
  const { address, isConnected } = useAccount(),
    [open, setOpen] = useState(false),
    pathname = usePathname();
  return (
    <>
      <nav className="top" aria-label="Main">
        <Link href="/" className="brand" aria-label={getBrand().name}>
          <span className="mark" />
          <span className="brand-name">{getBrand().name}</span>
        </Link>
        <div className="nav-tabs">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={isActive(pathname, href) ? "active" : undefined}
              aria-current={isActive(pathname, href) ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="nav-right">
          <Link href="/post" className="btn btn-primary" aria-label="Post a bounty">
            <span className="plus">+</span>
            <span className="nav-post-label">Post Bounty</span>
          </Link>
          {isConnected && address ? (
            <WalletMenu />
          ) : (
            <button type="button" onClick={() => setOpen(true)} className="btn btn-primary">
              Connect Wallet
            </button>
          )}
        </div>
      </nav>
      {open && !isConnected && <ConnectWalletModal onClose={() => setOpen(false)} />}
    </>
  );
}
