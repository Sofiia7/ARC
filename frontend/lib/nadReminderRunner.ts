import {createHash,randomBytes} from 'node:crypto';
import {createPublicClient,http} from 'viem';
import {BOUNTY_ADAPTER_V48_ABI as abi} from './abi-v48';
import {CONTRACTS} from './contracts';
import {getActiveNetwork} from './networks';
import {planNadReminders} from './nadReminders';
import {nadRedis} from './nadRedis';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Sends only to opt-in chat bindings; shares deduplication keys with the CLI. */
export async function runNadReminders(send:boolean){
  const network=getActiveNetwork();if(network.nativeCurrency.symbol!=='MON')throw Error('NadBounty only');
  const token=process.env.NAD_TELEGRAM_BOT_TOKEN;if(send&&!token)throw Error('Dedicated bot is required');
  const site=process.env.NAD_PUBLIC_SITE_URL??`https://${network.brand.domain}`;
  if(new URL(site).protocol!=='https:')throw Error('HTTPS site required');
  const pub=createPublicClient({transport:http(process.env.NAD_RPC_URL??network.rpcUrl,{timeout:15000,retryCount:2})});
  if(await pub.getChainId()!==network.chainId)throw Error('RPC chain mismatch');
  const adapter=CONTRACTS.BOUNTY_ADAPTER,block=await pub.getBlock();
  const total=await pub.readContract({address:adapter,abi,functionName:'totalBounties',blockNumber:block.number});
  if(total>2000n)throw Error('Indexed reminder discovery required');
  const owner=randomBytes(16).toString('hex'),runKey=`nad:tg:runner:${network.chainId}:${adapter}`;
  if(send&&!await nadRedis('SET',runKey,owner,'NX','EX',240))throw Error('Another reminder run holds the lease');
  let planned=0,sent=0;
  try{
    for(let i=0n;i<total;i++){
      const id=await pub.readContract({address:adapter,abi,functionName:'allJobIds',args:[i],blockNumber:block.number});
      const m=await pub.readContract({address:adapter,abi,functionName:'getBountyMeta',args:[id],blockNumber:block.number});
      if(m.resolved)continue;
      const entries=m.contest?await pub.readContract({address:adapter,abi,functionName:'getContestEntries',args:[id],blockNumber:block.number}):[];
      const closedAt=m.contest?(await pub.readContract({address:adapter,abi,functionName:'getContestState',args:[id],blockNumber:block.number}))[1]:0n;
      const challenges=[];
      if(m.contest)for(let j=0;j<entries.length;j++)challenges.push(await pub.readContract({address:adapter,abi,functionName:'getContestChallenge',args:[id,j],blockNumber:block.number}));
      const reminders=planNadReminders({...m,entries,closedAt,challenges},block.timestamp);planned+=reminders.length;
      if(!send)continue;
      const chat=await nadRedis<string|null>('GET',`nad:tg:wallet:${network.chainId}:${m.poster.toLowerCase()}`);if(!chat)continue;
      for(const reminder of reminders){
        if(await nadRedis('GET',runKey)!==owner)throw Error('Reminder lease expired');
        const key=`nad:tg:sent:${digest(`${network.chainId}:${adapter}:${id}:${m.poster}:${reminder.key}`)}`;
        if(await nadRedis('GET',key))continue;
        const lock=`${key}:lock`;
        if(!await nadRedis('SET',lock,owner,'NX','EX',120))continue;
        try{
          if(await nadRedis('GET',key))continue;
          const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:`${reminder.text}\n${site}/bounty/${id}`,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(10000)});
          if(!response.ok||(await response.json()).ok!==true)throw Error('Telegram send failed');
          await nadRedis('SET',key,'1','EX',31536000);sent++;
        }finally{await nadRedis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lock,owner);}
      }
    }
    return{chainId:network.chainId,adapter,send,scanned:String(total),sourceBlock:String(block.number),planned,sent};
  }finally{if(send)await nadRedis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,runKey,owner);}
}
