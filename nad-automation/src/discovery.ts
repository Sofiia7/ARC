/** Persist completed batches before a later RPC outage can force a full rescan. */
export async function scanHistory(options:{from:bigint;target:bigint;range?:bigint;maxCalls?:number;checkpointEvery?:number;fetch:(from:bigint,to:bigint)=>Promise<void>;checkpoint:(through:bigint)=>Promise<void>;sleep?:(ms:number)=>Promise<void>;progress?:(calls:number,through:bigint)=>void}) {
 const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 let from=options.from,calls=0;
 while(from<=options.target){
  if(++calls>(options.maxCalls??10000))throw Error('Recipient discovery exceeds bounded scan');
  const to=from+(options.range??100n)-1n>options.target?options.target:from+(options.range??100n)-1n;
  for(let attempt=0;;attempt++){
   try{await options.fetch(from,to);break;}
   catch(error){if(attempt>=5)throw error;await sleep(500*2**attempt);}
  }
  from=to+1n;
  if(calls%(options.checkpointEvery??100)===0||to===options.target){await options.checkpoint(to);options.progress?.(calls,to);}
  if(from<=options.target)await sleep(100);
 }
 return calls;
}

/**
 * Reads [from,to] in `window`-block slices strictly one at a time, pausing `gapMs` between them.
 * Public Monad RPCs refuse JSON-RPC batches (HTTP 403 "Restricted JSON RPC method") and answer
 * HTTP 429 above ~10 requests/s, so batching and Promise.all over the slices are both off the table.
 * ~125 ms gap + latency keeps a fast runner under ~8 req/s. Any failing slice rejects the whole
 * read: the caller retries the batch and no partial result is consumed.
 */
export async function readWindows<T>(options:{from:bigint;to:bigint;read:(from:bigint,to:bigint)=>Promise<T[]>;window?:bigint;gapMs?:number;sleep?:(ms:number)=>Promise<void>}):Promise<T[]> {
 const window=options.window??100n,gapMs=options.gapMs??125,sleep=options.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
 const out:T[]=[];
 for(let start=options.from;start<=options.to;start+=window){
  const end=start+window-1n>options.to?options.to:start+window-1n;
  out.push(...await options.read(start,end));
  if(end<options.to)await sleep(gapMs);
 }
 return out;
}
