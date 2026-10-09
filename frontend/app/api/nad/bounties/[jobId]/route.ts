import {NextRequest} from 'next/server';
import {nadApiClient,nadJson} from '@/lib/nadPublicApi';
import {rateLimited} from '@/lib/publicApi';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest,{params}:{params:Promise<{jobId:string}>}){
  const limited=await rateLimited(req);if(limited)return limited;
  const{jobId:raw}=await params;if(!/^\d{1,30}$/.test(raw))return nadJson({error:'Invalid job ID'},400);
  try{
    const{client,adapter,abi,block,info}=await nadApiClient(),jobId=BigInt(raw);
    const bounty=await client.readContract({address:adapter,abi,functionName:'getBountyMeta',args:[jobId],blockNumber:block.number});
    if(bounty.poster==='0x0000000000000000000000000000000000000000')return nadJson({error:'Bounty not found'},404);
    const entries=bounty.contest?await client.readContract({address:adapter,abi,functionName:'getContestEntries',args:[jobId],blockNumber:block.number}):undefined;
    const challenges=[];
    if(entries)for(let i=0;i<entries.length;i++)challenges.push(await client.readContract({address:adapter,abi,functionName:'getContestChallenge',args:[jobId,i],blockNumber:block.number}));
    const contestState=bounty.contest?await client.readContract({address:adapter,abi,functionName:'getContestState',args:[jobId],blockNumber:block.number}):undefined;
    return nadJson({...info,bounty,entries,challenges,contestState});
  }catch{return nadJson({error:'Could not read NadBounty V4.8'},502);}
}
