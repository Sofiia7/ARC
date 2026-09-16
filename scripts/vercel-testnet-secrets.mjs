/**
 * Copy the testnet build's three secrets from the root .env into the
 * arcbounty-testnet Vercel project (testnet.arcbounty.app), printing no value.
 *
 * Since 2026-09-16 the original `arcbounty` project serves Arc mainnet on
 * arcbounty.app and keeps its own copies. The testnet project needs the same
 * three: PINATA_JWT (IPFS pinning when someone posts a bounty), and
 * KEEPER_PRIVATE_KEY + CRON_SECRET (the daily keeper cron). Secrets have to be
 * written by a person, not by the coding agent, hence a script to run by hand.
 *
 * Calls the cached Vercel CLI 54 entry directly through node rather than
 * through `npx` in a shell: cmd would reinterpret characters inside the values,
 * and piping a value into `vercel env add` stores an empty string on Windows.
 *
 * Run from the repo root in cmd:
 *   node scripts\vercel-testnet-secrets.mjs
 * `--check` finds the CLI and the three variables, then exits writing nothing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const TEAM = "team_w5FWs16Vc9UdamtnCKeuJMtf";
const PROJECT = "prj_QQ6LoPxg0kI2wtY3Un54CVVyJ7iK"; // arcbounty-testnet
const NAMES = ["PINATA_JWT", "KEEPER_PRIVATE_KEY", "CRON_SECRET"];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readDotEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function findVercelCli() {
  const cache = join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache)) {
    const pkg = join(cache, dir, "node_modules", "vercel", "package.json");
    const entry = join(cache, dir, "node_modules", "vercel", "dist", "index.js");
    if (!existsSync(pkg) || !existsSync(entry)) continue;
    if (JSON.parse(readFileSync(pkg, "utf8")).version.startsWith("54.")) return entry;
  }
  return null;
}

const cli = findVercelCli();
if (!cli) {
  console.error("Vercel CLI 54 not found in the npx cache. Run once:  npx -y vercel@54 --version  and retry.");
  process.exit(1);
}

const env = readDotEnv(join(ROOT, ".env"));
const missing = NAMES.filter(name => !env[name]);
if (missing.length > 0) {
  console.error(`Missing in .env: ${missing.join(", ")}. Nothing was changed.`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  console.log(`CLI: ${cli}\nall present in .env: ${NAMES.join(", ")}\n--check: nothing written.`);
  process.exit(0);
}

const childEnv = { ...process.env, VERCEL_ORG_ID: TEAM, VERCEL_PROJECT_ID: PROJECT };
const scrub = text => NAMES.reduce((acc, name) => acc.split(env[name]).join("***"), text);

let failed = false;
for (const name of NAMES) {
  const run = spawnSync(
    process.execPath,
    [cli, "env", "add", name, "production", "--value", env[name], "--force", "--yes"],
    { env: childEnv, cwd: tmpdir(), encoding: "utf8" },
  );
  if (run.status === 0) {
    console.log(`ok      ${name}`);
  } else {
    failed = true;
    console.log(`FAILED  ${name}`);
    console.log(scrub(`${run.stdout ?? ""}${run.stderr ?? ""}`).trim());
  }
}

const list = spawnSync(process.execPath, [cli, "env", "ls"], { env: childEnv, cwd: tmpdir(), encoding: "utf8" });
console.log("\narcbounty-testnet production variables now:");
for (const line of scrub(list.stdout ?? "").split(/\r?\n/)) {
  if (/NEXT_PUBLIC_|PINATA_JWT|KEEPER_PRIVATE_KEY|CRON_SECRET/.test(line)) console.log(line.trim());
}
process.exit(failed ? 1 : 0);
