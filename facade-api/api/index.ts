import { buildApp } from "../src/app.js";

// Vercel function entry: every route is rewritten here (see vercel.json) and
// handled by the same Express app the Node entry uses. The app instance is
// built once per function instance - Fluid Compute reuses instances, so the
// in-memory cache and RPC pacing gate survive across requests within one
// instance (good enough for v1; a shared cache is Milestone-6 territory).
//
// `"framework": null` in vercel.json is load-bearing for that "every route"
// claim, and `"outputDirectory": "public"` (an empty directory) is what
// disabling detection then requires. Left to itself, Vercel recognises Express
// and generates a *second* function at the root whose handler it guesses to be
// src/app.ts - a module exporting buildApp(), not an app, so invoking it exits
// the process with "Invalid export found in module src/app.js". Functions
// occupy their paths during the filesystem phase, which runs before rewrites,
// so that stray function intercepted GET / - and only GET /, every other path
// falling through to the rewrite - and answered it with
// FUNCTION_INVOCATION_FAILED while the rest of the API looked healthy.
const { app } = buildApp();

export default app;
