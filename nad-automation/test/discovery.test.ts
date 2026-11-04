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

// Public Monad RPCs (rpc.monad.xyz, testnet-rpc.monad.xyz) answer every JSON-RPC batch with
// HTTP 403 "Restricted JSON RPC method" and answer 429 above ~10 requests/s. The recipient scan
// therefore reads its 100-block log windows one at a time, paced.
import {readFileSync} from 'node:fs';
import {readWindows} from '../src/discovery.js';
test('log range is read in exact 100-block windows, in order, with no gap or overlap',async()=>{
 const seen:[bigint,bigint][]=[];
 const out=await readWindows<string>({from:1000n,to:1249n,sleep:async()=>{},read:async(a,b)=>{seen.push([a,b]);return [`${a}-${b}`];}});
 assert.deepEqual(seen,[[1000n,1099n],[1100n,1199n],[1200n,1249n]]);
 assert.deepEqual(out,['1000-1099','1100-1199','1200-1249']);
});
test('a range of exactly one window and a one-block range each issue a single read',async()=>{
 const seen:[bigint,bigint][]=[];const read=async(a:bigint,b:bigint)=>{seen.push([a,b]);return [] as string[];};
 await readWindows({from:500n,to:599n,sleep:async()=>{},read});await readWindows({from:7n,to:7n,sleep:async()=>{},read});
 assert.deepEqual(seen,[[500n,599n],[7n,7n]]);
});
test('windows are never read concurrently (concurrency is what trips the 429 limit)',async()=>{
 let inFlight=0,peak=0;
 await readWindows({from:0n,to:999n,sleep:async()=>{},read:async()=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setImmediate(r));inFlight--;return [];}});
 assert.equal(peak,1);
});
test('it pauses between windows but not after the last one',async()=>{
 const pauses:number[]=[];
 await readWindows({from:0n,to:299n,gapMs:125,sleep:async ms=>{pauses.push(ms);},read:async()=>[]});
 assert.deepEqual(pauses,[125,125]);
 const single:number[]=[];await readWindows({from:0n,to:99n,sleep:async ms=>{single.push(ms);},read:async()=>[]});assert.deepEqual(single,[]);
});
test('a failing window rejects the whole read so scanHistory retries the batch and nothing partial is consumed',async()=>{
 let reads=0;
 await assert.rejects(readWindows({from:0n,to:999n,sleep:async()=>{},read:async a=>{reads++;if(a===300n)throw Error('429');return [a];}}),/429/);
 assert.equal(reads,4);
});
test('sync.ts never turns JSON-RPC batching on for the log client (public Monad RPC answers batches with 403)',()=>{
 const source=readFileSync(new URL('../src/sync.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\bbatch\s*:/,'http({batch:...}) makes every getLogs fail with HttpRequestError 403 Restricted JSON RPC method');
 assert.doesNotMatch(source,/Promise\.all\(\s*requests\s*\)/,'fan-out over log windows trips the 429 limit; use readWindows');
});
