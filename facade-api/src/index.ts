import { buildApp } from "./app.js";
import { VERSION } from "./config.js";

// Plain Node entry (local dev, Docker). Vercel uses api/index.ts instead.
const { app, gate, config } = buildApp();

app.listen(config.port, () => {
  console.log(
    `[facade] ArcBounty facade API v${VERSION} on :${config.port} — payment mode: ${gate.mode}` +
    (gate.mode === "free" ? " (set SELLER_ADDRESS for x402)" : ` (seller ${config.sellerAddress})`),
  );
});
