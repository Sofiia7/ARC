# Security incident — secrets rotation checklist (Sprint 0)

`.env` and `frontend/.env.local` contained live credentials on a Windows + OneDrive box.
Treat them as **publicly compromised** even though git does not track them.

## 1. Immediate rotation (do this first, in order)

- [ ] **New deployer wallet**
  - Generate a fresh keypair (e.g. `cast wallet new`).
  - Transfer remaining ARC and USDC from the old `PRIVATE_KEY` to the new address.
  - Replace `PRIVATE_KEY` in every local `.env` / Vercel env / GitHub Actions secret.

- [ ] **Arbitrator handover** — IF the compromised deployer wallet is the current `arbitrator()`:
  - From the old key (while you still control it): `BountyAdapter.transferArbitrator(NEW_ARBITRATOR)`.
  - From the new key: `BountyAdapter.acceptArbitrator()`.
  - Verify on chain: `cast call $BOUNTY_ADAPTER "arbitrator()(address)"`.
  - **Losing this key = disputes freeze forever.**

- [ ] **Fee recipient** — `feeRecipient` is immutable. If it equals the old key's address:
  - You can't change it without redeploying.
  - Short-term mitigation: sweep accrued fees regularly into a clean address.
  - Long-term: schedule a redeploy in Sprint 1.

- [ ] **Pinata**
  - Revoke the leaked `PINATA_JWT` in Pinata UI → API Keys.
  - Generate a new JWT scoped to `pinFileToIPFS` / v3 uploads only — no admin scope.
  - If `PINATA_API_KEY` + `PINATA_SECRET` ever existed: revoke both.

- [ ] **WalletConnect**
  - In WalletConnect Cloud dashboard, rotate `NEXT_PUBLIC_WC_PROJECT_ID` (delete + recreate).

## 2. History audit

- [ ] `git log --all -p -- .env frontend/.env.local`  (locally)
- [ ] On GitHub: search the org for the leaked private key prefix and Pinata JWT prefix.
  Use https://github.com/search?q=... + `gitleaks` / `trufflehog`.
- [ ] If anything is found:
  - `git filter-repo --invert-paths --path .env --path frontend/.env.local --force`
  - Force-push, notify collaborators to re-clone.
  - **Still rotate** — once leaked, always leaked.
- [ ] Inspect Vercel deploy logs and GitHub Actions logs for the same prefixes.

## 3. Block the next incident

- [ ] `.env*` already gitignored except `*.example` — verified.
- [ ] Install pre-commit hook to block `.env` files containing real-looking secrets:

  ```bash
  npm i -D husky lint-staged
  npx husky init
  echo 'npx gitleaks --redact protect --staged --no-banner' > .husky/pre-commit
  ```

- [ ] In CI, run `gitleaks detect --redact --no-banner` against full history on every push.

- [ ] Move the working copy off OneDrive-synced folders, or exclude `.env*` from OneDrive sync
  (Settings → OneDrive → Account → Choose folders).

## 4. Re-deploy decisions

The contract is fine to keep using on testnet after Sprint 0 — escrowed funds are in AC,
not in the leaked wallet. But for mainnet you want a deploy from a hardware-wallet-derived
key, never reusing the testnet deployer.

## Owners

- [ ] @<you> — wallet rotation + Pinata rotation
- [ ] @<you> — git history audit
- [ ] @<you> — pre-commit + CI gitleaks
