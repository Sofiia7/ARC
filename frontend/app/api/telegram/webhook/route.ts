import {NextRequest,NextResponse} from 'next/server';
import {createHash,timingSafeEqual} from 'node:crypto';
import {nadRedis} from '@/lib/nadRedis';
import {NadRequestError,readNadJson} from '@/lib/nadRequest';
export const runtime='nodejs';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
async function say(chat:number,text:string){
  const token=process.env.NAD_TELEGRAM_BOT_TOKEN;if(!token)throw Error('Bot not configured');
  const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text}),signal:AbortSignal.timeout(10000)});
  if(!response.ok||(await response.json()).ok!==true)throw Error('Telegram request failed');
}
export async function POST(req:NextRequest){
  const secret=process.env.NAD_TELEGRAM_WEBHOOK_SECRET,received=req.headers.get('x-telegram-bot-api-secret-token')??'';
  const expectedBytes=Buffer.from(secret??''),receivedBytes=Buffer.from(received);
  if(!secret||receivedBytes.length!==expectedBytes.length||!timingSafeEqual(receivedBytes,expectedBytes))return NextResponse.json({error:'unauthorized'},{status:401});
  try{
    const message=(await readNadJson(req,32768) as {message?:any})?.message;
    if(!message||message.chat?.type!=='private'||message.from?.id!==message.chat.id)return NextResponse.json({ok:true});
    const chat=message.chat.id,text=String(message.text??'');
    if(text==='/stop'){
      const bindings=await nadRedis<string[]>('SMEMBERS',`nad:tg:chat:${chat}`);
      for(const binding of bindings){const key=`nad:tg:wallet:${binding}`;await nadRedis('EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,key,String(chat));}
      await nadRedis('DEL',`nad:tg:chat:${chat}`);await say(chat,'NadBounty reminders stopped. Link your wallet again on the site to resume.');
    }else if(/^\/start [A-Za-z0-9_-]{32}$/.test(text)){
      const saved=await nadRedis<string|null>('GETDEL',`nad:tg:start:${digest(text.slice(7))}`);
      if(!saved){await say(chat,'This wallet link expired or was already used. Create a new link on NadBounty.');return NextResponse.json({ok:true});}
      const {wallet,chainId}=JSON.parse(saved),binding=`${chainId}:${wallet}`;
      await nadRedis('SET',`nad:tg:wallet:${binding}`,String(chat));await nadRedis('SADD',`nad:tg:chat:${chat}`,binding);
      await say(chat,`NadBounty reminders enabled for ${wallet} on chain ${chainId}. Entries, review deadlines and challenges will arrive here. Use /stop to unlink.`);
    }else if(text.startsWith('/start'))await say(chat,'Open NadBounty, connect your poster wallet and choose Telegram reminders to link it.');
    return NextResponse.json({ok:true});
  }catch(e){if(e instanceof NadRequestError)return NextResponse.json({error:e.message},{status:e.status});return NextResponse.json({error:'Webhook processing failed'},{status:503});}
}
