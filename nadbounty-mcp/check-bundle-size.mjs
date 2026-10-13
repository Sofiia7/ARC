// Fail when a packed bundle is over 25 MB, the size catalogs advise staying under for an .mcpb;
// the bundle holds production dependencies only (`npm install --omit=dev`), which is what keeps it well below that.
//
//   node check-bundle-size.mjs <file.mcpb> [more files...]
import { statSync } from "node:fs";

const MAX_BYTES = 25 * 1024 * 1024;
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node check-bundle-size.mjs <file.mcpb> [more files...]");
  process.exit(2);
}
let failed = false;
for (const file of files) {
  const size = statSync(file).size;
  const mb = (size / 1024 / 1024).toFixed(1);
  if (size > MAX_BYTES) {
    console.error(`${file}: ${mb} MB is over the 25 MB limit`);
    failed = true;
  } else {
    console.log(`${file}: ${mb} MB (limit 25 MB)`);
  }
}
process.exit(failed ? 1 : 0);
