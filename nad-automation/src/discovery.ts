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
