import {NextRequest} from 'next/server';
import {nadApiClient,nadJson} from '@/lib/nadPublicApi';
import {rateLimited} from '@/lib/publicApi';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest){
  const limited=await rateLimited(req);if(limited)return limited;
  const limit=Number(req.nextUrl.searchParams.get('limit')??'25'),offset=Number(req.nextUrl.searchParams.get('offset')??'0');
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)return nadJson({error:'limit must be 1–100; offset must be a nonnegative integer'},400);
  try{
    const{client,adapter,abi,block,info}=await nadApiClient();
    const total=await client.readContract({address:adapter,abi,functionName:'totalBounties',blockNumber:block.number});
    const bounties=[];
    for(let i=total-1n-BigInt(offset);i>=0n&&bounties.length<limit;i--){
      const id=await client.readContract({address:adapter,abi,functionName:'allJobIds',args:[i],blockNumber:block.number});
      bounties.push(await client.readContract({address:adapter,abi,functionName:'getBountyMeta',args:[id],blockNumber:block.number}));
    }
    return nadJson({...info,total,offset,limit,bounties});
  }catch{return nadJson({error:'Could not read NadBounty V4.8'},502);}
}
