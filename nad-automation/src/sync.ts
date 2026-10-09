/** Testnet-only exact source sync. Dry by default; Safe must authorize the dedicated writer. */
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createPublicClient,createWalletClient,defineChain,http,parseAbi,parseAbiItem,type Address,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {resolveNetwork} from 'arcbounty-agent-sdk';
import {readReputationSource,encodeMirrorReport,needsMirrorUpdate} from './reputation.js';
import {nadRedis} from './redis.js';
const env=process.env;
const plan=JSON.parse(readFileSync(new URL('../config/testnet.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
if(!/^0x[0-9a-fA-F]{64}$/.test(env.NAD_REPUTATION_RELAYER_PRIVATE_KEY??'')||/^0x0+$/.test(env.NAD_REPUTATION_RELAYER_PRIVATE_KEY??''))throw Error('Dedicated reputation key is missing or invalid');
const mirror='0x59e970574D9aDc30892d094C893DA4B73EBE40a0' as Address;
const rpc=env.NAD_RPC_URL??'https://testnet-rpc.monad.xyz';
const chain=defineChain({id:10143,name:'Monad Testnet',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const client=createPublicClient({chain,transport:http(rpc,{timeout:20000,retryCount:2})});
const logClient=createPublicClient({chain,transport:http('https://testnet-rpc.monad.xyz',{timeout:20000,retryCount:2})});
const account=privateKeyToAccount(env.NAD_REPUTATION_RELAYER_PRIVATE_KEY as Hex);
const wallet=createWalletClient({chain,account,transport:http(rpc)});
const abi=parseAbi(['function owner() view returns(address)','function relayer() view returns(address)','function onReport(bytes,bytes)','function records(address,uint256) view returns(uint64,uint128,uint64,uint256)']);
const event=parseAbiItem('event ReputationUpdated(address indexed identityOwner,uint256 indexed sourceChain,uint64 sourceBlock,uint64 paidJobs,uint128 scoreSum)');
const prefix=`nad:rep:10143:${mirror.toLowerCase()}`,lease=`${prefix}:lease`,leaseToken=randomUUID();
let acquired=false;
let phase='target-chain';
try {
 if(await client.getChainId()!==10143||plan.mirror.toLowerCase()!==mirror.toLowerCase()||plan.relayer.toLowerCase()!==account.address.toLowerCase())throw Error('Target/key mismatch');
 phase='target-finalized-block';const target=await client.getBlock({blockTag:'finalized'});if(!target.number||!target.hash)throw Error('No finalized target');
 phase='target-governance';
 const owner=await client.readContract({address:mirror,abi,functionName:'owner',blockNumber:target.number});
 if(owner.toLowerCase()!==plan.safe.toLowerCase())throw Error('Mirror governance mismatch');
 phase='redis-lease';acquired=await nadRedis<string|null>('SET',lease,leaseToken,'NX','EX',1800)==='OK';if(!acquired)throw Error('Another reputation sync holds the lease');
 phase='recipient-discovery';
 const recipients=new Map<number,Set<Address>>([[8453,new Set()],[5042,new Set()]]);
 for(const source of recipients.keys())for(const value of await nadRedis<Address[]>('SMEMBERS',`${prefix}:recipients:${source}`))recipients.get(source)!.add(value);
 // Chain history reconstructs ALL prior recipients even if the local cache or Redis is lost.
 const cursor=await nadRedis<string|null>('GET',`${prefix}:discovery-cursor`);
 const saved=cursor?BigInt(cursor):69191994n;
 if(saved>target.number)throw Error('Recipient cursor is ahead of finalized chain');
 let from=saved>69192122n?saved-128n:69191994n,range=100n,calls=0;
 while(from<=target.number){
   if(++calls>10000)throw Error('Recipient discovery exceeds bounded scan');
   const to=from+range-1n>target.number?target.number:from+range-1n;
   try{const logs=await logClient.getLogs({address:mirror,event,fromBlock:from,toBlock:to,strict:true});for(const log of logs){const set=recipients.get(Number(log.args.sourceChain));if(!set)throw Error('Unexpected mirror source');set.add(log.args.identityOwner);}from=to+1n;}
   catch{if(range<=100n)throw Error('Recipient history discovery failed');range=range/2n<100n?100n:range/2n;}
   if(calls%100===0)console.error(JSON.stringify({phase,calls,scannedThrough:String(from-1n),targetBlock:String(target.number)}));
 }
 const check=await client.getBlock({blockNumber:target.number});if(check.hash!==target.hash)throw Error('Target snapshot changed');
 const snapshots=[];
 for(const name of ['base-mainnet','arc-mainnet'] as const){
   phase=`source-${name}`;
   console.error(JSON.stringify({phase}));
   const n=resolveNetwork(name,env),adapters=[n.defaultBountyAdapter!];
   if(name==='base-mainnet')adapters.push('0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c');
   const old=[...recipients.get(n.chainId)!];if(old.length>10000)throw Error('Recipient set exceeds cap');
   snapshots.push(await readReputationSource({chainId:n.chainId as 8453|5042,rpcUrl:n.rpcUrl,adapters,identity:n.contracts.IDENTITY_REGISTRY,reputation:n.contracts.REPUTATION_REGISTRY},old));
 }
 const broadcast=process.argv.includes('--broadcast');
 phase='target-writer';
 const relayer=await client.readContract({address:mirror,abi,functionName:'relayer'});
 const authorized=relayer.toLowerCase()===account.address.toLowerCase();
 if(broadcast&&!authorized)throw Error('Safe has not authorized this reputation writer');
 const transactions=[];let budget=0n;let unchangedRecords=0;
 for(const snapshot of snapshots){
   phase=`journal-${snapshot.sourceChain}`;
   const key=`${prefix}:recipients:${snapshot.sourceChain}`;
   // Write-ahead recipient journal survives an uncertain receipt or a process crash.
   if(snapshot.records.length)await nadRedis('SADD',key,...snapshot.records.map(r=>r.identityOwner));
   const changed=[];
   for(const r of snapshot.records){
     const actual=await client.readContract({address:mirror,abi,functionName:'records',args:[r.identityOwner,BigInt(r.sourceChain)]});
     if(!needsMirrorUpdate(r,actual)){unchangedRecords++;continue;}
     changed.push(r);
   }
   for(let i=0;i<changed.length;i+=100){
     const records=changed.slice(i,i+100),report=encodeMirrorReport(records);
     if(!broadcast)continue;
     if(await nadRedis('GET',lease)!==leaseToken)throw Error('Sync lease lost');
     const estimate=await client.estimateContractGas({account:account.address,address:mirror,abi,functionName:'onReport',args:['0x',report]});
     const gas=estimate+(estimate+1n)/2n,gasPrice=await client.getGasPrice(),fee=gas*gasPrice;
     if(fee>150_000_000_000_000_000n||budget+fee>500_000_000_000_000_000n||await client.getBalance({address:account.address})<fee*2n)throw Error('Relayer gas budget or balance insufficient');
     const hash=await wallet.writeContract({address:mirror,abi,functionName:'onReport',args:['0x',report],gas,gasPrice});
     const receipt=await client.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error('Mirror update reverted');budget+=fee;transactions.push(hash);
     for(const r of records){const actual=await client.readContract({address:mirror,abi,functionName:'records',args:[r.identityOwner,BigInt(r.sourceChain)]});if(actual[2]<r.sourceBlock||(actual[2]===r.sourceBlock&&(actual[0]!==r.paidJobs||actual[1]!==r.scoreSum)))throw Error('Mirror readback mismatch');}
   }
 }
 // Advance only after every old/new recipient has been durably journaled.
 await nadRedis('SET',`${prefix}:discovery-cursor`,String(target.number));
 const result={chainId:10143,mirror,relayer:account.address,authorized,broadcast,targetBlock:target.number,targetHash:target.hash,recipientDiscoveryCalls:calls,snapshots,unchangedRecords,transactions};
 const output=JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2);
 writeFileSync(env.NAD_SYNC_OUTPUT??'reputation-sync.json',output);console.log(output);
}catch(error){console.error(JSON.stringify({phase,errorType:error instanceof Error?error.name:'Unknown',message:'Reputation sync stopped; private transport and keys suppressed'}));process.exitCode=1;}
finally{if(acquired)await nadRedis('EVAL',"if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lease,leaseToken);}
