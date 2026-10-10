import {test} from 'node:test';import assert from 'node:assert/strict';
import {scanHistory} from '../src/discovery.js';
test('a later outage preserves completed journal checkpoints and does not skip the failed batch',async()=>{
 const checkpoints:bigint[]=[];let attempts=0;
 await assert.rejects(scanHistory({from:0n,target:10100n,sleep:async()=>{},fetch:async from=>{if(from===10000n){attempts++;throw Error('RPC outage');}},checkpoint:async n=>{checkpoints.push(n);}}));
 assert.deepEqual(checkpoints,[9999n]);assert.equal(attempts,6);
 const resumed:bigint[]=[];await scanHistory({from:9871n,target:10100n,sleep:async()=>{},fetch:async from=>{resumed.push(from);},checkpoint:async n=>{checkpoints.push(n);}});
 assert.equal(resumed[0],9871n);assert.equal(checkpoints.at(-1),10100n);
});
test('transient failure retries the same batch and only checkpoints after successful consumption',async()=>{
 const ranges:bigint[]=[];const checkpoints:bigint[]=[];let failed=false;
 await scanHistory({from:5n,target:205n,sleep:async()=>{},fetch:async from=>{ranges.push(from);if(!failed){failed=true;throw Error('Rate limit');}},checkpoint:async n=>{checkpoints.push(n);}});
 assert.deepEqual(ranges,[5n,5n,105n,205n]);assert.deepEqual(checkpoints,[205n]);
});
