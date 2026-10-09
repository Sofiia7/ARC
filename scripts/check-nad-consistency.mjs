import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
for(const name of ['abi-v48.ts','contestEncryption.ts','nadKeeper.ts','reputationMirrorAbi.ts'])assert.equal(readFileSync(new URL(`../frontend/lib/${name}`,import.meta.url),'utf8'),readFileSync(new URL(`../agent-sdk/src/${name}`,import.meta.url),'utf8'),`${name}: frontend/SDK drift`);
for(const name of ['abi-v48.ts','nadKeeper.ts'])assert.equal(readFileSync(new URL(`../nad-cre/reputation-sync/${name}`,import.meta.url),'utf8'),readFileSync(new URL(`../agent-sdk/src/${name}`,import.meta.url),'utf8'),`${name}: CRE/SDK drift`);
console.log('NadBounty frontend ABI and encryption match the SDK exactly.');
