import { buildApp } from "../src/app.js";

// Vercel function entry: every route is rewritten here (see vercel.json) and
// handled by the same Express app the Node entry uses. The app instance is
// built once per function instance — Fluid Compute reuses instances, so the
// in-memory cache and RPC pacing gate survive across requests within one
// instance (good enough for v1; a shared cache is Milestone-6 territory).
const { app } = buildApp();

export default app;
