import {CronCapability,EVMClient,handler,Runner,bytesToHex,encodeCallMsg,LAST_FINALIZED_BLOCK_NUMBER,type Runtime} from '@chainlink/cre-sdk';
import {decodeFunctionResult,encodeFunctionData,parseAbi,zeroAddress,type Address} from 'viem';
import {BOUNTY_ADAPTER_V48_ABI as abi} from './abi-v48';
import {NAD_SETTLEMENTS,selectNadSettlement,type NadKeeperContest} from './nadKeeper';
export type KeeperConfig={schedule:string;chainSelector:string;adapter:Address;receiver:Address;jobIds:string[];writeReports:boolean};
const readAbi=parseAbi(['function adapter() view returns(address)','function adapterKind() view returns(uint8)','function agenticCommerce() view returns(address)','function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))']);
function onKeeper(runtime:Runtime<KeeperConfig>){
  const c=runtime.config;if(c.jobIds.length>100)throw Error('At most 100 explicit candidates per invocation');
  const evm=new EVMClient(BigInt(c.chainSelector));
  const call=(to:Address,data:`0x${string}`)=>bytesToHex(evm.callContract(runtime,{call:encodeCallMsg({from:zeroAddress,to,data}),blockNumber:LAST_FINALIZED_BLOCK_NUMBER}).result().data);
  const receiverAdapter=decodeFunctionResult({abi:readAbi,functionName:'adapter',data:call(c.receiver,encodeFunctionData({abi:readAbi,functionName:'adapter'}))});
  const kind=decodeFunctionResult({abi:readAbi,functionName:'adapterKind',data:call(c.receiver,encodeFunctionData({abi:readAbi,functionName:'adapterKind'}))});
  if(receiverAdapter.toLowerCase()!==c.adapter.toLowerCase()||kind!==1)throw Error('Receiver adapter mismatch');
  const escrow=decodeFunctionResult({abi:readAbi,functionName:'agenticCommerce',data:call(c.adapter,encodeFunctionData({abi:readAbi,functionName:'agenticCommerce'}))});
  const now=BigInt(Math.floor(runtime.now().getTime()/1000));
  const actions:{kind:number;jobId:bigint}[]=[];
  for(const rawId of [...new Set(c.jobIds)]){
    if(!/^[1-9]\d{0,29}$/.test(rawId))throw Error('Invalid job ID');const jobId=BigInt(rawId);
    const meta=decodeFunctionResult({abi,functionName:'getBountyMeta',data:call(c.adapter,encodeFunctionData({abi,functionName:'getBountyMeta',args:[jobId]}))});
    if(meta.poster===zeroAddress||meta.resolved)continue;
    let contest:NadKeeperContest|undefined;
    if(meta.contest){
      const state=decodeFunctionResult({abi,functionName:'getContestState',data:call(c.adapter,encodeFunctionData({abi,functionName:'getContestState',args:[jobId]}))});
      const indices=decodeFunctionResult({abi,functionName:'getContestChallengers',data:call(c.adapter,encodeFunctionData({abi,functionName:'getContestChallengers',args:[jobId]}))});
      const challenges=indices.map(index=>decodeFunctionResult({abi,functionName:'getContestChallenge',data:call(c.adapter,encodeFunctionData({abi,functionName:'getContestChallenge',args:[jobId,index]}))}));
      contest={entryCount:Number(state[0]),closedAt:state[1],challenges};
    }
    const expired=now>meta.deadline+7776000n&&decodeFunctionResult({abi:readAbi,functionName:'getJob',data:call(escrow,encodeFunctionData({abi:readAbi,functionName:'getJob',args:[jobId]}))}).status===5;
    const action=selectNadSettlement(meta,now,contest,expired);
    if(action)actions.push({kind:NAD_SETTLEMENTS.indexOf(action),jobId});
    if(actions.length===10)break;
  }
  runtime.log(`Keeper: ${actions.length} eligible actions; reports ${c.writeReports?'enabled':'disabled'}`);
  if(!actions.length||!c.writeReports)return actions.map(a=>`${a.kind}:${a.jobId}`).join(',');
  // A Monad report must be estimated and budgeted before broadcast: it charges the limit.
  // Keep this simulation-only until that integration and Safe reporter configuration exist.
  throw Error('CRE keeper broadcast disabled until gas budgeting and Safe reporter configuration are verified');
}
const initKeeper=(config:KeeperConfig)=>[handler(new CronCapability().trigger({schedule:config.schedule}),onKeeper)];
export async function main(){const runner=await Runner.newRunner<KeeperConfig>();await runner.run(initKeeper);}
