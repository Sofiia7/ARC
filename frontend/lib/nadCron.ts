import { randomBytes } from 'node:crypto';
import { nadRedis } from './nadRedis';
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BOUNTY_ADAPTER_V48_ABI as abi } from './abi-v48';
import { selectNadSettlement, type NadKeeperContest } from './nadKeeper';
import { CONTRACTS } from './contracts';
import { activeChain } from './wagmi';

const escrowAbi=parseAbi(['function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))']);
let running=false;
/** Dedicated Monad key and bounded spending; no inherited Arc keeper credentials. */
export async function runNadCron(dryRun:boolean){
  if(running)throw Error('Keeper run already in progress');
  running=true;
  let lockKey:string|undefined,lockOwner:string|undefined;
  try{
    const key=process.env.NAD_KEEPER_PRIVATE_KEY as Hex|undefined;
    if(!dryRun&&!key)throw Error('NAD_KEEPER_PRIVATE_KEY is required for broadcast');
    const account=key?privateKeyToAccount(key):undefined;
    const chain=activeChain,transport=http(process.env.NAD_RPC_URL??chain.rpcUrls.default.http[0],{timeout:15000,retryCount:1});
    const pub=createPublicClient({chain,transport});
    const wallet=account?createWalletClient({account,chain,transport}):undefined;
    if(await pub.getChainId()!==chain.id)throw Error('Monad RPC chain mismatch');
    const adapter=CONTRACTS.BOUNTY_ADAPTER;
    if(!dryRun){lockKey=`nad:keeper:${chain.id}:${adapter}:${account!.address}`;lockOwner=randomBytes(16).toString('hex');if(!await nadRedis('SET',lockKey,lockOwner,'NX','EX',300))throw Error('Another keeper holds the lease');}
    for(const [functionName,expected] of [['usdc',CONTRACTS.USDC],['identityRegistry',CONTRACTS.IDENTITY_REGISTRY],['agenticCommerce',CONTRACTS.AGENTIC_COMMERCE]] as const){
      const actual=await pub.readContract({address:adapter,abi,functionName});
      if(actual.toLowerCase()!==expected.toLowerCase())throw Error(`Monad ${functionName} mismatch`);
    }
    for(const [functionName,expected] of [['APPROVAL_TIMEOUT',1209600n],['REJECTION_CHALLENGE_WINDOW',172800n],['DISPUTE_RESPONSE_WINDOW',172800n],['ARBITRATOR_TIMEOUT',2592000n]] as const){
      if(await pub.readContract({address:adapter,abi,functionName})!==expected)throw Error('Keeper deadline constants mismatch');
    }
    const total=await pub.readContract({address:adapter,abi,functionName:'totalBounties'});
    // Do not silently scan only the first page. Move discovery to the indexer at scale.
    if(total>2000n)throw Error('Indexed candidate discovery required above 2000 jobs');
    const candidates:{jobId:string;action:string;hash?:Hex;gasLimit?:string;status?:string;error?:string}[]=[];
    let budget=0n;
    for(let i=0n;i<total;i++){
      const id=await pub.readContract({address:adapter,abi,functionName:'allJobIds',args:[i]});
      const meta=await pub.readContract({address:adapter,abi,functionName:'getBountyMeta',args:[id]});
      if(meta.resolved)continue;
      let contest:NadKeeperContest|undefined;
      if(meta.contest){
        const state=await pub.readContract({address:adapter,abi,functionName:'getContestState',args:[id]});
        const indices=await pub.readContract({address:adapter,abi,functionName:'getContestChallengers',args:[id]});
        const challenges=[];
        for(const index of indices)challenges.push(await pub.readContract({address:adapter,abi,functionName:'getContestChallenge',args:[id,index]}));
        contest={entryCount:Number(state[0]),closedAt:state[1],challenges};
      }
      const now=(await pub.getBlock()).timestamp;
      const expired=now>meta.deadline+7776000n&&(await pub.readContract({address:CONTRACTS.AGENTIC_COMMERCE,abi:escrowAbi,functionName:'getJob',args:[id]})).status===5;
      const action=selectNadSettlement(meta,now,contest,expired);
      if(!action)continue;
      const candidate:typeof candidates[number]={jobId:String(id),action};candidates.push(candidate);
      if(dryRun)continue;
      try{
        if(await nadRedis('GET',lockKey!)!==lockOwner)throw Error('Keeper lease expired');
        const estimate=await pub.estimateContractGas({account,address:adapter,abi,functionName:action,args:[id]});
        const gas=estimate+(estimate+1n)/2n,gasPrice=await pub.getGasPrice(),cost=gas*gasPrice;
        if(cost>150000000000000000n||budget+cost>1000000000000000000n)throw Error('MON gas budget exceeded');
        if(await pub.getBalance({address:account!.address})<cost*2n)throw Error('Keeper MON balance too low');
        // Fix gasPrice to the value checked against the cap: do not reprice after budgeting.
        budget+=cost;candidate.gasLimit=String(gas);
        candidate.hash=await wallet!.writeContract({address:adapter,abi,functionName:action,args:[id],gas,gasPrice});
        const receipt=await pub.waitForTransactionReceipt({hash:candidate.hash,timeout:60000});
        candidate.status=receipt.status;
        if(receipt.status!=='success')throw Error('Settlement reverted');
      }catch{candidate.error=candidate.hash?'Settlement not confirmed; check its transaction before retrying':'Settlement simulation or gas budget failed';}
    }
    return {chainId:chain.id,adapter,dryRun,scanned:String(total),candidates};
  }finally{try{if(lockKey&&lockOwner)await nadRedis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lockKey,lockOwner);}finally{running=false;}}
}
