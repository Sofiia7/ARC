import {NextRequest,NextResponse} from 'next/server';
import {createHash,randomBytes} from 'node:crypto';
import {createPublicClient,http,isAddress,type Address,type Hex} from 'viem';
import {nadRedis} from '@/lib/nadRedis';
import {getActiveNetwork} from '@/lib/networks';
import {NadRequestError,readNadJson} from '@/lib/nadRequest';
import {clientKey} from '@/lib/rate-limit';
export const runtime='nodejs';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export async function POST(req:NextRequest){
  try{
    const network=getActiveNetwork();
    if(network.nativeCurrency.symbol!=='MON')return NextResponse.json({error:'NadBounty only'},{status:404});
    const origin=new URL(process.env.NAD_PUBLIC_SITE_URL??`https://${network.brand.domain}`).origin;
    if(req.headers.get('origin')!==origin)return NextResponse.json({error:'Invalid origin'},{status:403});
    const ipBucket=`nad:tg:ip:${digest(`${clientKey(req)}:${Math.floor(Date.now()/60000)}`)}`;
    const ipCount=await nadRedis<number>('INCR',ipBucket);if(ipCount===1)await nadRedis('EXPIRE',ipBucket,120);
    if(ipCount>30)return NextResponse.json({error:'Try again in a minute'},{status:429});
    const body=await readNadJson(req,8192) as {wallet?:unknown;signature?:unknown;nonce?:unknown};
    if(typeof body?.wallet!=='string'||!isAddress(body.wallet))return NextResponse.json({error:'Invalid wallet'},{status:400});
    const wallet=body.wallet.toLowerCase() as Address;
    const bucket=`nad:tg:rate:${digest(`${wallet}:${Math.floor(Date.now()/60000)}`)}`;
    const count=await nadRedis<number>('INCR',bucket);if(count===1)await nadRedis('EXPIRE',bucket,120);
    if(count>10)return NextResponse.json({error:'Try again in a minute'},{status:429});
    const bot=process.env.NAD_TELEGRAM_BOT_USERNAME;
    if(!bot||!/^[A-Za-z0-9_]{5,32}$/.test(bot))throw Error('Bot not configured');
    if(!body.signature){
      const nonce=randomBytes(24).toString('hex'),expires=Date.now()+300000;
      const message=`NadBounty Telegram reminders v1\nSite: ${origin}\nChain: ${network.chainId}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(expires).toISOString()}\nPurpose: link this wallet to the Telegram chat where I press Start. No transaction or spending permission.`;
      await nadRedis('SET',`nad:tg:nonce:${digest(nonce)}`,JSON.stringify({wallet,message}), 'EX',300);
      return NextResponse.json({nonce,message});
    }
    if(typeof body.nonce!=='string'||!/^[a-f0-9]{48}$/.test(body.nonce))return NextResponse.json({error:'Invalid nonce'},{status:400});
    const nonceKey=`nad:tg:nonce:${digest(body.nonce)}`,saved=await nadRedis<string|null>('GET',nonceKey);
    if(!saved)return NextResponse.json({error:'Link request expired or already used'},{status:409});
    const record=JSON.parse(saved);
    const pub=createPublicClient({transport:http(process.env.NAD_RPC_URL??network.rpcUrl,{timeout:15000,retryCount:1})});
    if(await pub.getChainId()!==network.chainId)throw Error('RPC chain mismatch');
    if(record.wallet!==wallet||!await pub.verifyMessage({address:wallet,message:record.message,signature:body.signature as Hex}))return NextResponse.json({error:'Invalid wallet signature'},{status:401});
    if(await nadRedis<string|null>('GETDEL',nonceKey)!==saved)return NextResponse.json({error:'Link request already used'},{status:409});
    const code=randomBytes(24).toString('base64url');
    await nadRedis('SET',`nad:tg:start:${digest(code)}`,JSON.stringify({wallet,chainId:network.chainId}),'EX',300);
    return NextResponse.json({url:`https://t.me/${bot}?start=${code}`,expiresInSeconds:300});
  }catch(e){if(e instanceof NadRequestError)return NextResponse.json({error:e.message},{status:e.status});return NextResponse.json({error:'Telegram linking is unavailable; no wallet was linked'},{status:503});}
}
