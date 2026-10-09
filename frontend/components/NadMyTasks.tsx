"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useAccount,usePublicClient} from 'wagmi';
import {formatUnits,type ContractFunctionReturnType} from 'viem';
import {CONTRACTS} from '@/lib/contracts';
import {BOUNTY_ADAPTER_V48_ABI as abi} from '@/lib/abi-v48';
type Meta=ContractFunctionReturnType<typeof abi,'view','getBountyMeta'>;
export function NadMyTasks(){
  const{address}=useAccount(),client=usePublicClient();const[id,setId]=useState('0'),[rows,setRows]=useState<Meta[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{setRows([]);setError('');},[address]);
  async function load(){if(!client||!address)return;setBusy(true);setError('');setRows([]);try{
    if(!/^\d{1,30}$/.test(id))throw Error('Invalid agent ID');
    const posted=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getMyPostedBounties',args:[address]});
    const assigned=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getMyAssignedBounties',args:[address]});
    const byAgent=BigInt(id)?await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getAgentBounties',args:[BigInt(id)]}):[];
    const ids=[...new Set([...posted,...assigned,...byAgent])].sort((a,b)=>a>b?-1:a<b?1:0).slice(0,100);
    const metas=[];for(const jobId of ids)metas.push(await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getBountyMeta',args:[jobId]}));setRows(metas);
  }catch(e){setError(e instanceof Error?e.message:'Could not read tasks');}finally{setBusy(false);}}
  return <main className="max-w-4xl mx-auto p-6 space-y-5"><h1 className="text-3xl">My tasks</h1>{!address?<p>Connect your wallet to see posted bounties and entered contests.</p>:<><label className="block">Optional agent ID · includes its history after wallet rotation<input className="block bg-black/30 border p-3" value={id} onChange={e=>setId(e.target.value)}/></label><button className="btn btn-primary" disabled={busy} onClick={()=>void load()}>{busy?'Reading…':'Load latest 100 tasks'}</button>{error&&<p role="alert">{error}</p>}{rows.map(m=><Link className="block border rounded-xl p-4" href={`/bounty/${m.jobId}`} key={String(m.jobId)}>#{String(m.jobId)} · {m.contest?'Contest':'Bounty'} · {formatUnits(m.reward,6)} USDC · {m.resolved?'Resolved':m.inDispute?'In dispute':'Active'}</Link>)}</>}</main>;
}
