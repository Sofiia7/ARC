import {CronCapability,HTTPCapability,HTTPClient,EVMClient,handler,Runner,consensusIdenticalAggregation,ok,text,bytesToHex,encodeCallMsg,blockNumber,protoBigIntToBigint,LAST_FINALIZED_BLOCK_NUMBER,type HTTPSendRequester,type HTTPPayload,type Runtime} from '@chainlink/cre-sdk';
import {decodeFunctionResult,encodeFunctionData,parseAbi,zeroAddress,keccak256,type Address,type Hex} from 'viem';
import {BOUNTY_ADAPTER_ABI as legacy} from './legacyAbi';
import {aggregateReputation,encodeMirrorReport,type Feedback,type OwnerRecord} from './reputationModel';
type Config={schedule:string;sourceUrl:string;baseSelector:string;targetSelector:string;mirror:Address;safe:Address;authorizedCaller:Address;writeReports:boolean};
type Source={sourceChain:number;sourceBlock:string;sourceHash:Hex;scanned:string;identities:{agentId:string;owner:Address}[];records:{identityOwner:Address;sourceChain:number;sourceBlock:string;paidJobs:string;scoreSum:string}[]};
type Evidence={targetChainId:number;mirror:Address;verifiedAt:string;snapshots:Source[]};
const identity='0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as Address;
const reputation='0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as Address;
const clients=['0x32c215908a46Eb5D34e4E5146c99891eD3014Fee','0x9b0B27c20DF10BFc667F4316d7175166Ff8c4c2c'] as Address[];
const registryAbi=parseAbi(['function owner() view returns(address)','function relayer() view returns(address)','function identityRegistry() view returns(address)','function reputationRegistry() view returns(address)','function ownerOf(uint256) view returns(address)','function getIdentityRegistry() view returns(address)','function readAllFeedback(uint256,address[],string,string,bool) view returns(address[],uint64[],int128[],uint8[],string[],string[],bool[])']);
const fetchEvidence=(requester:HTTPSendRequester,url:string)=>{
 const response=requester.sendRequest({url,method:'GET'}).result();
 if(!ok(response))throw Error('Finalized source API unavailable');
 const body=text(response);if(body.length>500000)throw Error('Source API response exceeds bound');return body;
};
const canonical=(records:OwnerRecord[])=>JSON.stringify(records.map(r=>[r.identityOwner.toLowerCase(),r.sourceChain,String(r.sourceBlock),String(r.paidJobs),String(r.scoreSum)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
function synchronize(runtime:Runtime<Config>){
 const c=runtime.config;
 if(c.sourceUrl!=='https://nadbounty-facade-testnet.vercel.app/v1/reputation-sources'||c.baseSelector!=='15971525489660198786'||c.targetSelector!=='2183018362218727504'||c.mirror.toLowerCase()!=='0x59e970574d9adc30892d094c893da4b73ebe40a0')throw Error('Unexpected verified testnet source/target');
 const raw=new HTTPClient().sendRequest(runtime,fetchEvidence,consensusIdenticalAggregation<string>())(c.sourceUrl).result();
 const data=JSON.parse(raw) as Evidence;
 if(data.targetChainId!==10143||data.mirror.toLowerCase()!==c.mirror.toLowerCase()||data.snapshots.length!==2||new Set(data.snapshots.map(s=>s.sourceChain)).size!==2)throw Error('Source domain mismatch');
 const records:OwnerRecord[]=[];
 for(const s of data.snapshots){
  if(![8453,5042].includes(s.sourceChain)||!/^\d+$/.test(s.sourceBlock)||!/^0x[0-9a-fA-F]{64}$/.test(s.sourceHash)||s.records.length>100||s.identities.length>100)throw Error('Invalid source provenance');
  for(const r of s.records){
   if(r.sourceChain!==s.sourceChain||r.sourceBlock!==s.sourceBlock||!/^\d+$/.test(r.paidJobs)||!/^\d+$/.test(r.scoreSum))throw Error('Invalid record provenance');
   records.push({identityOwner:r.identityOwner,sourceChain:r.sourceChain,sourceBlock:BigInt(r.sourceBlock),paidJobs:BigInt(r.paidJobs),scoreSum:BigInt(r.scoreSum)});
  }
 }
 const base=data.snapshots.find(s=>s.sourceChain===8453)!;
 const evm=new EVMClient(BigInt(c.baseSelector)),height=blockNumber(base.sourceBlock);
 const finalHeader=evm.headerByNumber(runtime,{blockNumber:LAST_FINALIZED_BLOCK_NUMBER}).result().header;
 const header=evm.headerByNumber(runtime,{blockNumber:height}).result().header;
 if(!finalHeader?.blockNumber||!header||BigInt(base.sourceBlock)>protoBigIntToBigint(finalHeader.blockNumber)||bytesToHex(header.hash).toLowerCase()!==base.sourceHash.toLowerCase())throw Error('Base source block/hash is not finalized');
 const multiAbi=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] results)']);
 type Read={to:Address;abi:typeof registryAbi|typeof legacy;name:string;args?:unknown[]};
 const batch=(reads:Read[])=>{
  if(!reads.length)return [];
  const calls=reads.map(r=>({target:r.to,allowFailure:false,callData:encodeFunctionData({abi:r.abi,functionName:r.name as never,args:(r.args??[]) as never})}));
  const data=bytesToHex(evm.callContract(runtime,{call:encodeCallMsg({from:zeroAddress,to:'0xcA11bde05977b3631167028862bE2a173976CA11',data:encodeFunctionData({abi:multiAbi,functionName:'aggregate3',args:[calls]})}),blockNumber:height}).result().data);
  const results=decodeFunctionResult({abi:multiAbi,functionName:'aggregate3',data});
  if(results.length!==reads.length||results.some(r=>!r.success))throw Error('Base batched read failed');
  return results.map((r,i)=>decodeFunctionResult({abi:reads[i].abi,functionName:reads[i].name as never,data:r.returnData}) as any);
 };
 const wiring=batch([{to:reputation,abi:registryAbi,name:'getIdentityRegistry'},...clients.flatMap(to=>[{to,abi:registryAbi,name:'identityRegistry'},{to,abi:registryAbi,name:'reputationRegistry'},{to,abi:legacy,name:'totalBounties'}])]);
 if(wiring[0].toLowerCase()!==identity.toLowerCase())throw Error('Base registry identity mismatch');
 let scanned=0n;const jobs:Read[]=[];
 clients.forEach((to,i)=>{
  if(wiring[1+i*3].toLowerCase()!==identity.toLowerCase()||wiring[2+i*3].toLowerCase()!==reputation.toLowerCase())throw Error('Base writer registry mismatch');
  const total=wiring[3+i*3] as bigint;scanned+=total;
  if(scanned>100n)throw Error('Indexed candidate discovery required above 100 Base jobs in CRE');
  for(let j=0n;j<total;j++)jobs.push({to,abi:legacy,name:'allJobIds',args:[j]});
 });
 const jobIds=batch(jobs),metas=batch(jobs.map((r,i)=>({to:r.to,abi:legacy,name:'getBountyMeta',args:[jobIds[i]]})));
 const ids=new Set<bigint>(metas.filter(m=>m.agentId>0n).map(m=>m.agentId));
 if(scanned!==BigInt(base.scanned)||ids.size!==base.identities.length||new Set(base.identities.map(i=>i.agentId)).size!==ids.size)throw Error('Base candidate set mismatch');
 const owners=new Map<bigint,Address>(),feedback:Feedback[]=[];
 const idList=[...ids],ownerRows=batch(idList.map(id=>({to:identity,abi:registryAbi,name:'ownerOf',args:[id]})));
 const feedbackRows=batch(idList.map(id=>({to:reputation,abi:registryAbi,name:'readAllFeedback',args:[id,clients,'','',true]})));
 idList.forEach((id,k)=>{
  const owner=ownerRows[k] as Address;
  if(base.identities.find(i=>i.agentId===String(id))?.owner.toLowerCase()!==owner.toLowerCase())throw Error('Base same-block owner mismatch');owners.set(id,owner);
  const rows=feedbackRows[k] as [Address[],bigint[],bigint[],number[],string[],string[],boolean[]];
  if(rows[0].length>10000||rows.some(row=>row.length!==rows[0].length))throw Error('Malformed Base feedback');
  for(let i=0;i<rows[0].length;i++)feedback.push({agentId:id,client:rows[0][i],index:rows[1][i],value:rows[2][i],decimals:rows[3][i],tag:rows[4][i],tag2:rows[5][i],revoked:rows[6][i]});
 });
 const supplied=records.filter(r=>r.sourceChain===8453);
 const actual=aggregateReputation(8453,BigInt(base.sourceBlock),clients,owners,feedback,supplied.map(r=>r.identityOwner));
 if(canonical(actual)!==canonical(supplied))throw Error('Base raw feedback differs from supplied exact sums');
 const target=new EVMClient(BigInt(c.targetSelector));
 const targetRead=(functionName:'owner'|'relayer')=>decodeFunctionResult({abi:registryAbi,functionName,data:bytesToHex(target.callContract(runtime,{call:encodeCallMsg({from:zeroAddress,to:c.mirror,data:encodeFunctionData({abi:registryAbi,functionName})}),blockNumber:LAST_FINALIZED_BLOCK_NUMBER}).result().data)}) as Address;
 if(targetRead('owner').toLowerCase()!==c.safe.toLowerCase()||targetRead('relayer').toLowerCase()!=='0x77edc6ecfa56019fd57dec360d8f3862c4d44226')throw Error('Target governance mismatch');
 const report=encodeMirrorReport(records),hash=keccak256(report);
 runtime.log(`Exact reputation report: ${records.length} records, Base ${base.sourceBlock}, Arc ${data.snapshots.find(s=>s.sourceChain===5042)!.sourceBlock}, hash ${hash}`);
 if(c.writeReports)throw Error('CRE report broadcasting disabled; scheduled trusted delivery uses separately budgeted runner');
 return report;
}
const onHttp=(runtime:Runtime<Config>,payload:HTTPPayload)=>{if(payload.input.length>1024)throw Error('HTTP trigger payload too large');return synchronize(runtime);};
const init=(config:Config)=>[
 handler(new CronCapability().trigger({schedule:config.schedule}),synchronize),
 handler(new HTTPCapability().trigger({authorizedKeys:[{type:'KEY_TYPE_ECDSA_EVM',publicKey:config.authorizedCaller}]}),onHttp),
];
export async function main(){const runner=await Runner.newRunner<Config>();await runner.run(init);}
