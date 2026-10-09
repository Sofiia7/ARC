import {resolveNetwork} from 'arcbounty-agent-sdk';
import {readReputationSource} from './reputation.js';
import type {Address} from 'viem';
const prefix='nad:rep:10143:0x59e970574d9adc30892d094c893da4b73ebe40a0';
let cached:{at:number;value:Awaited<ReturnType<typeof load>>}|undefined;
let pending:ReturnType<typeof load>|undefined;
async function previousOwners(chainId:number):Promise<Address[]>{
 const url=process.env.NAD_UPSTASH_REDIS_REST_URL,token=process.env.NAD_UPSTASH_REDIS_REST_TOKEN;
 if(!url||!token||new URL(url).protocol!=='https:'||!new URL(url).hostname.endsWith('.upstash.io'))throw Error('Recipient journal is required');
 const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(['SMEMBERS',`${prefix}:recipients:${chainId}`]),signal:AbortSignal.timeout(10000)});
 const data=await response.json();
 if(!response.ok||data.error||!Array.isArray(data.result)||data.result.length>10000||data.result.some((a:unknown)=>typeof a!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(a)))throw Error('Invalid recipient journal');
 return data.result;
}
async function load(){
 const snapshots=await Promise.all((['base-mainnet','arc-mainnet'] as const).map(async name=>{
  const n=resolveNetwork(name,process.env),adapters=[n.defaultBountyAdapter!];
  if(name==='base-mainnet')adapters.push('0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c');
  return readReputationSource({chainId:n.chainId as 8453|5042,rpcUrl:n.rpcUrl,adapters,identity:n.contracts.IDENTITY_REGISTRY,reputation:n.contracts.REPUTATION_REGISTRY},await previousOwners(n.chainId));
 }));
 return {targetChainId:10143,mirror:'0x59e970574D9aDc30892d094C893DA4B73EBE40a0',verifiedAt:new Date().toISOString(),snapshots};
}
/** Public exact finalized source evidence; no writes, keys or private transport URLs. */
export async function reputationSources(){
 if(cached&&Date.now()-cached.at<60000)return cached.value;
 pending??=load();
 try{const value=await pending;cached={at:Date.now(),value};return value;}finally{pending=undefined;}
}
