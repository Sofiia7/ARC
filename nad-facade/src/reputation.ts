import {createPublicClient,http,parseAbi,type Address} from 'viem';
import {BOUNTY_ADAPTER_ABI} from 'arcbounty-agent-sdk';
import {aggregateReputation,type Feedback} from './model.js';
export * from './model.js';
const registryAbi = parseAbi([
  'function ownerOf(uint256) view returns(address)',
  'function getIdentityRegistry() view returns(address)',
  'function readAllFeedback(uint256,address[],string,string,bool) view returns(address[],uint64[],int128[],uint8[],string[],string[],bool[])',
]);
const wiringAbi=parseAbi(['function identityRegistry() view returns(address)','function reputationRegistry() view returns(address)']);

export type ReputationSource = {chainId: 8453|5042; rpcUrl: string; adapters: Address[]; identity: Address; reputation: Address};
export async function readReputationSource(source: ReputationSource, previousOwners: Address[] = []) {
  const client=createPublicClient({transport:http(source.rpcUrl,{timeout:20000,retryCount:2})});
  if(await client.getChainId()!==source.chainId) throw Error('Wrong reputation source chain');
  // Fail if finalized is unsupported; never silently substitute a moving latest snapshot.
  const block=await client.getBlock({blockTag:'finalized'});
  if(!block.number || !block.hash) throw Error('Missing finalized source block');
  const blockNumber=block.number;
  const identity=await client.readContract({address:source.reputation,abi:registryAbi,functionName:'getIdentityRegistry',blockNumber});
  if(identity.toLowerCase()!==source.identity.toLowerCase()) throw Error('Registry identity mismatch');
  const agentIds=new Set<bigint>(); let scanned=0n;
  for(const address of source.adapters) {
    for (const [name,expected] of [['identityRegistry',source.identity],['reputationRegistry',source.reputation]] as const) {
      const actual=await client.readContract({address,abi:wiringAbi,functionName:name,blockNumber});
      if(actual.toLowerCase()!==expected.toLowerCase()) throw Error('Source adapter registry mismatch');
    }
    const total=await client.readContract({address,abi:BOUNTY_ADAPTER_ABI,functionName:'totalBounties',blockNumber});
    scanned+=total; if(scanned>2000n) throw Error('Indexed candidate discovery required above 2000 jobs');
    for(let i=0n;i<total;i++) {
      const id=await client.readContract({address,abi:BOUNTY_ADAPTER_ABI,functionName:'allJobIds',args:[i],blockNumber});
      const meta=await client.readContract({address,abi:BOUNTY_ADAPTER_ABI,functionName:'getBountyMeta',args:[id],blockNumber});
      if(meta.agentId>0n) agentIds.add(meta.agentId);
    }
  }
  const owners=new Map<bigint,Address>(), feedback: Feedback[]=[];
  for(const agentId of agentIds) {
    owners.set(agentId,await client.readContract({address:source.identity,abi:registryAbi,functionName:'ownerOf',args:[agentId],blockNumber}));
    const rows=await client.readContract({address:source.reputation,abi:registryAbi,functionName:'readAllFeedback',args:[agentId,source.adapters,'','',true],blockNumber});
    if(rows.some(row=>row.length!==rows[0].length) || rows[0].length>10000) throw Error('Malformed or oversized feedback response');
    for(let i=0;i<rows[0].length;i++) feedback.push({agentId,client:rows[0][i],index:rows[1][i],value:rows[2][i],decimals:rows[3][i],tag:rows[4][i],tag2:rows[5][i],revoked:rows[6][i]});
  }
  const check=await client.getBlock({blockNumber});
  if(check.hash!==block.hash) throw Error('Source snapshot changed');
  return {sourceChain:source.chainId,sourceBlock:blockNumber,sourceHash:block.hash,scanned,agents:agentIds.size,identities:[...owners].map(([agentId,owner])=>({agentId,owner})),feedback:feedback.length,records:aggregateReputation(source.chainId,blockNumber,source.adapters,owners,feedback,previousOwners)};
}
