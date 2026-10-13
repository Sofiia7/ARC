import { createApp } from "./createApp.js";
import { configuration } from "./config.js";
try {
  const config = configuration(process.env);
  const app = createApp(config);
  app.listen(config.port, "127.0.0.1", () =>
    console.log(`NadBounty x402 listening on ${config.port}; chain ${config.chainId}`),
  );
} catch (error) {
  console.error("NadBounty facade startup failed; check the network, adapter and treasury settings:", error);
  process.exitCode = 1;
}
