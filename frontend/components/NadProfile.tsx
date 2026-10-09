"use client";
import {useEffect,useState} from 'react';
import {useAccount,usePublicClient} from 'wagmi';
import {isAddress,parseAbi,type Address} from 'viem';
import {CONTRACTS} from '@/lib/contracts';
import {BOUNTY_ADAPTER_V48_ABI as abi} from '@/lib/abi-v48';
import {REPUTATION_MIRROR_ABI as mirrorAbi} from '@/lib/reputationMirrorAbi';
const identityAbi=parseAbi(['function ownerOf(uint256) view returns(address)','function getAgentWallet(uint256) view returns(address)']);
const average=(jobs:bigint,sum:bigint)=>jobs?`${Number(sum*100n/jobs)/100}`:'—';
export function NadProfile(){
  const{address}=useAccount(),client=usePublicClient();const[id,setId]=useState('0'),[human,setHuman]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const[data,setData]=useState<{owner:Address;working:Address|null;total:readonly[bigint,bigint];sources:{name:string;chainId:bigint;record:readonly[bigint,bigint,bigint,bigint]}[];relayer:Address}>();
  useEffect(()=>{if(address)setHuman(address);},[address]);
  useEffect(()=>{const query=new URLSearchParams(window.location.search);if(/^\d+$/.test(query.get('agent')??''))setId(query.get('agent')!);},[]);
  async function load(){if(!client)return;setBusy(true);setError('');setData(undefined);try{
    if(!/^\d{1,30}$/.test(id))throw Error('Enter a valid agent ID');
    const agentId=BigInt(id);if(!agentId&&!isAddress(human))throw Error('Enter a human wallet address or an agent ID');
    const owner=agentId?await client.readContract({address:CONTRACTS.IDENTITY_REGISTRY,abi:identityAbi,functionName:'ownerOf',args:[agentId]}):human as Address;
    const working=agentId?await client.readContract({address:CONTRACTS.IDENTITY_REGISTRY,abi:identityAbi,functionName:'getAgentWallet',args:[agentId]}):null;
    const mirror=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'reputationMirror'});
    const total=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getIdentityReputation',args:[agentId,owner]});
    const sources=[];
    for(const[name,chainId]of[['Base',8453n],['Arc',5042n]] as const)sources.push({name,chainId,record:await client.readContract({address:mirror,abi:mirrorAbi,functionName:'records',args:[owner,chainId]})});
    const relayer=await client.readContract({address:mirror,abi:mirrorAbi,functionName:'relayer'});
    setData({owner,working,total,sources,relayer});
  }catch(e){setError(e instanceof Error?e.message:'Could not read profile');}finally{setBusy(false);}}
  return <main className="max-w-4xl mx-auto p-6 space-y-6"><h1 className="text-3xl">Identity reputation</h1><p>Scored paid jobs on Monad, plus Base and Arc records synchronized for the current identity owner. Working-wallet changes do not move the identity&apos;s reputation.</p><label className="block">Agent ID · 0 for a human<input className="bg-black/30 border p-3 block w-full" value={id} onChange={e=>setId(e.target.value)}/></label>{id==='0'&&<label className="block">Human wallet<input className="bg-black/30 border p-3 block w-full" value={human} onChange={e=>setHuman(e.target.value)}/></label>}<button className="btn btn-primary" disabled={busy} onClick={()=>void load()}>{busy?'Reading…':'Read on-chain profile'}</button>{error&&<p role="alert" className="break-words">{error}</p>}{data&&<><section className="border rounded-xl p-5 space-y-2"><p className="break-all">Current owner: {data.owner}</p>{data.working&&<p className="break-all">Current working wallet: {data.working}</p>}<p>Total qualifying jobs: {String(data.total[0])} · score sum: {String(data.total[1])} · weighted average: {average(...data.total)}</p><p>Proven: {data.total[0]>=3n&&data.total[1]>=80n*data.total[0]?'qualified':'not yet'} · Top: {data.total[0]>=10n&&data.total[1]>=90n*data.total[0]?'qualified':'not yet'}</p></section><div className="grid md:grid-cols-2 gap-4">{data.sources.map(source=><section className="border rounded-xl p-5" key={source.name}><h2 className="text-xl">{source.name}</h2>{source.record[2]===0n?<p>No synchronized record.</p>:<><p>{String(source.record[0])} paid jobs · score sum {String(source.record[1])} · average {average(source.record[0],source.record[1])}</p><p>Source block: {String(source.record[2])} · updated {new Date(Number(source.record[3])*1000).toLocaleString()}</p></>}</section>)}</div><p className="text-sm">Mirrored reputation trusts our relayer for Base and Arc. Arc data is supplied by our API. Every record includes its source block for verification. {data.relayer==='0x0000000000000000000000000000000000000000'?'The trusted relayer is currently disabled.':''}</p></>}</main>;
}
