/** Vercel Express entry point. The app is built on first use and does no network I/O while it is built. */
import express from "express";
import { createApp } from "./createApp.js";
import { configuration } from "./config.js";

const app = express();
app.disable("x-powered-by");
let handler: ReturnType<typeof createApp> | undefined;
app.use((req, res, next) => {
  try {
    handler ??= createApp(configuration(process.env));
    handler(req, res, next);
  } catch (error) {
    // A configuration problem is static for the life of the process; report it generically and keep logging it.
    console.error("[facade] initialization failed:", error);
    if (!res.headersSent)
      res.status(503).set("Retry-After", "30").json({ error: "Payment service initialization unavailable" });
  }
});
export default app;
