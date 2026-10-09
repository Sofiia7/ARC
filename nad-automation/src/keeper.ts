/** Scheduled permissionless V4.8 runner. Dry by default; never bypasses adapter deadlines. */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nadRedis } from './redis.js';
import { createPublicClient,createWalletClient,defineChain,http,parseAbi,isAddress,type Hex,type Address } from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import { NadBountyAgent,MONAD_NETWORKS,type MonadNetworkName } from 'arcbounty-agent-sdk';
import { selectNadSettlement,type NadKeeperContest } from 'arcbounty-agent-sdk';
import { BOUNTY_ADAPTER_V48_ABI } from 'arcbounty-agent-sdk';
const network=process.env.NAD_NETWORK??'monad-testnet';if(network!=='monad-testnet')throw Error('Invalid NAD_NETWORK');
const n=MONAD_NETWORKS[network as MonadNetworkName];
const adapter=process.env.NAD_BOUNTY_ADAPTER_ADDRESS??(network==='monad-testnet'?'0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020':undefined);
if(!adapter||!isAddress(adapter))throw Error('Explicit mainnet adapter required');
const rpc=process.env.NAD_RPC_URL??n.rpcUrl;
const chain=defineChain({id:n.chainId,name:network,nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const pub=createPublicClient({chain,transport:http(rpc,{timeout:20000,retryCount:2})});
let key=process.env.NAD_KEEPER_PRIVATE_KEY as Hex|undefined;
if(key&&!/^0x[0-9a-fA-F]{64}$/.test(key))throw Error('Invalid dedicated keeper key');
const wallet=key?createWalletClient({chain,account:privateKeyToAccount(key),transport:http(rpc)}):undefined;
const agent=new NadBountyAgent({network:network as MonadNetworkName,bountyAdapterAddress:adapter as Address,rpcUrl:rpc,privateKey:key});
const read=(functionName:string,args:readonly unknown[]=[])=>pub.readContract({address:adapter,abi:BOUNTY_ADAPTER_V48_ABI,functionName:functionName as never,args:args as never}) as Promise<any>;
const pause=()=>new Promise(r=>setTimeout(r,150));
const escrowAbi=parseAbi(['function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))']);
const lease=`nad:keeper:10143:${adapter.toLowerCase()}`,leaseToken=randomUUID();let acquired=false;
try{
  if(await pub.getChainId()!==n.chainId)throw Error('Wrong RPC chain');
  if(adapter.toLowerCase()!=='0xf88b980b3ab1cd5a2befd9c0b88b70196f215020')throw Error('Unexpected testnet adapter');
  const broadcast=process.argv.includes('--broadcast');if(broadcast&&!key)throw Error('NAD_KEEPER_PRIVATE_KEY required');
  if(broadcast){acquired=await nadRedis('SET',lease,leaseToken,'NX','EX',900)==='OK';if(!acquired)throw Error('Another keeper holds the lease');}
  for(const[name,expected]of [['APPROVAL_TIMEOUT',1209600n],['REJECTION_CHALLENGE_WINDOW',172800n],['DISPUTE_RESPONSE_WINDOW',172800n],['ARBITRATOR_TIMEOUT',2592000n]] as const){await pause();if(await read(name)!==expected)throw Error('Keeper clock constants mismatch');}
  const total=await agent.totalBounties(),maxScan=BigInt(process.env.NAD_KEEPER_MAX_SCAN??'2000');
  if(maxScan<1n||maxScan>10000n||total>maxScan)throw Error('Board exceeds scan cap; configure indexed candidate discovery');
  const candidates=[];let cost=0n;
  for(let i=0n;i<total;i++){
    await pause();const id=await read('allJobIds',[i]);const meta=await agent.getBounty(id);if(meta.resolved)continue;
    let contest:NadKeeperContest|undefined;
    if(meta.contest){await pause();const state=await agent.getContestState(id);const indices=await agent.getContestChallengers(id);const challenges=[];for(const index of indices){await pause();challenges.push(await agent.getContestChallenge(id,index));}contest={entryCount:Number(state[0]),closedAt:state[1],challenges};}
    const now=(await pub.getBlock()).timestamp;
    let escrowExpired=false;
    if(now>meta.deadline+7776000n){const escrow=await read('agenticCommerce');await pause();escrowExpired=(await pub.readContract({address:escrow,abi:escrowAbi,functionName:'getJob',args:[id]})).status===5;}
    const action=selectNadSettlement(meta,now,contest,escrowExpired);if(!action)continue;
    const candidate:any={jobId:id.toString(),action};candidates.push(candidate);
    // Estimate the exact call. Stale/raced candidates remain isolated from the rest.
    try{
      const estimate=await pub.estimateContractGas({account:agent.address,address:adapter,abi:BOUNTY_ADAPTER_V48_ABI,functionName:action,args:[id]});
      const gas=estimate+(estimate+1n)/2n,fee=gas*await pub.getGasPrice();candidate.gasLimit=gas.toString();
      if(fee>150_000_000_000_000_000n||cost+fee>1_000_000_000_000_000_000n)throw Error('Keeper gas budget exceeded');
      if(broadcast){
        if(await nadRedis('GET',lease)!==leaseToken)throw Error('Keeper lease lost');
        if(await pub.getBalance({address:agent.address})<fee*2n)throw Error('Keeper needs more MON');
        const gasPrice=await pub.getGasPrice(),checkedFee=gas*gasPrice;
        if(checkedFee>150_000_000_000_000_000n||cost+checkedFee>1_000_000_000_000_000_000n||await pub.getBalance({address:agent.address})<checkedFee*2n)throw Error('Final keeper gas budget exceeded');
        cost+=checkedFee;
        const hash=await wallet!.writeContract({address:adapter,abi:BOUNTY_ADAPTER_V48_ABI,functionName:action,args:[id],gas,gasPrice});candidate.hash=hash;
        const receipt=await pub.waitForTransactionReceipt({hash,timeout:60000});candidate.status=receipt.status;
        if(receipt.status!=='success')throw Error('Settlement failed');
        if(!(await agent.getBounty(id)).resolved)throw Error('Settlement readback failed');
      }
    }catch(error){candidate.error='Keeper call stopped; transport and key details suppressed';}
  }
  const output=JSON.stringify({network,chainId:n.chainId,adapter,broadcast,total:total.toString(),candidates},null,2);
  writeFileSync(process.env.NAD_KEEPER_OUTPUT??'keeper-run.json',output);console.log(output);
  if(candidates.some(c=>c.error))process.exitCode=1;
}catch(error){console.error('Keeper call stopped; transport and key details suppressed');process.exitCode=1;}
finally{if(acquired)await nadRedis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lease,leaseToken);}
