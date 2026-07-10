# Security incident — secrets rotation (Sprint 0) — CLOSED

## What happened

`.env` and `frontend/.env.local` held live credentials on a Windows box with the
working copy inside a OneDrive-synced folder. Neither file was ever committed to
git (confirmed by a full-history `gitleaks` scan — 63 commits, zero real secret
matches; every hit was a false positive on vendored OpenZeppelin test fixtures).
The exposure was the OneDrive sync itself, not a git leak. Treated as compromised
regardless, out of caution.

**No mainnet funds were at risk** — this project has never deployed to Arc
mainnet. All exposure was testnet-only.

## What was done

- [x] **New deployer wallet** — generated fresh, funded, and used for the
  then-current V3.2 deployment (`0x5E7106382bA80c8805A570dEE4cB4bC321a8Ed83`)
  and every deployment since (V3.3/V4/V4.1/V4.2/V4.3/V4.4 — see `contracts/DEPLOYMENTS.md`
  for the current live address). Old key's remaining testnet ARC/USDC swept.
- [x] **Arbitrator** — moot for the handover procedure: V3.2 is a fresh deploy, so
  `arbitrator()` was set to the new wallet at construction, not transferred from
  the old one. Confirmed on-chain via `cast call ... arbitrator()(address)`.
- [x] **Fee recipient** — `feeRecipient` was never the compromised deployer
  address (it's a distinct wallet), so no redeploy was forced by this specifically.
- [x] **Pinata** — old JWT revoked, new JWT issued and confirmed working
  end-to-end (seed script + frontend IPFS routes, live-tested against V3.2).
- [x] **WalletConnect** (`NEXT_PUBLIC_WC_PROJECT_ID`) — rotated 2026-07-07:
  a fresh project ID was issued in the Reown (WalletConnect Cloud)
  dashboard and deployed to Vercel production + local env. The ID is
  public by design (it ships in the client bundle) — the real protections
  are deleting the old project and domain-restricting the new one to
  `arcbounty.app` in the dashboard; both are dashboard-side settings.
- [x] **History audit** — full-history `gitleaks --redact` scan run; no real
  secrets found (see "What happened" above).
- [x] **Pre-commit hook** — `.githooks/pre-commit` installed and
  `core.hooksPath` set; blocks any real `.env*` file from being staged, plus a
  `gitleaks protect --staged` content-scan layer.
- [x] **CI gitleaks gate** — `.github/workflows/ci.yml` runs `gitleaks-action`
  against full history (`fetch-depth: 0`) on every push.
- [x] **Moved off OneDrive** — working copy relocated to a non-synced path.

## Mainnet note

Testnet redeploys are fine with a regular hot-wallet key. For the actual Arc
mainnet deploy, use a hardware-wallet-derived key — never reuse a testnet
deployer key for mainnet, incident or not.
