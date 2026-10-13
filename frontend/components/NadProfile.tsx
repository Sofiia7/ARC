"use client";
import {useEffect,useState} from 'react';
import {useAccount,usePublicClient} from 'wagmi';
import {isAddress,parseAbi,type Address} from 'viem';
import {CONTRACTS} from '@/lib/contracts';
import {BOUNTY_ADAPTER_V48_ABI as abi} from '@/lib/abi-v48';
import {REPUTATION_MIRROR_ABI as mirrorAbi} from '@/lib/reputationMirrorAbi';
const identityAbi=parseAbi(['function ownerOf(uint256) view returns(address)','function getAgentWallet(uint256) view returns(address)']);
const average=(jobs:bigint,sum:bigint)=>jobs?`${Number(sum*100n/jobs)/100}`:'-';
const mono:React.CSSProperties={fontFamily:'var(--font-jetbrains-mono), monospace',fontSize:13,overflowWrap:'anywhere'};
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
  const proven=!!data&&data.total[0]>=3n&&data.total[1]>=80n*data.total[0],top=!!data&&data.total[0]>=10n&&data.total[1]>=90n*data.total[0];
  return <>
    <header className="page-head"><h1>Identity reputation</h1><p className="sub">Scored paid jobs on Monad, plus Base and Arc records synchronized for the current identity owner. Working-wallet changes do not move the identity&apos;s reputation.</p></header>
    <form className="form-card" onSubmit={e=>{e.preventDefault();void load();}}>
      <div className="form-grid-2">
        <div className="form-row"><label className="form-label" htmlFor="profile-agent">Agent ID <span className="hint">0 for a human</span></label><input id="profile-agent" className="input" inputMode="numeric" value={id} onChange={e=>setId(e.target.value)}/></div>
        {id==='0'&&<div className="form-row"><label className="form-label" htmlFor="profile-human">Human wallet</label><input id="profile-human" className="input" value={human} onChange={e=>setHuman(e.target.value)} placeholder="0x…"/></div>}
      </div>
      {error&&<p role="alert" style={{color:'#FFC9BC',margin:0,overflowWrap:'anywhere'}}>{error}</p>}
      <button type="submit" className="btn btn-primary btn-big" disabled={busy}>{busy?'Reading…':'Read on-chain profile'}</button>
    </form>
    {data&&<>
      <div className="stat-grid" style={{marginTop:22}}>
        <div className="stat-card"><div className="stat-label">Qualifying jobs</div><div className="stat-value">{String(data.total[0])}</div><div className="stat-hint">Monad plus mirrored Base and Arc</div></div>
        <div className="stat-card"><div className="stat-label">Score sum</div><div className="stat-value">{String(data.total[1])}</div><div className="stat-hint">exact, never rounded</div></div>
        <div className="stat-card"><div className="stat-label">Weighted average</div><div className="stat-value">{average(...data.total)}</div><div className="stat-hint">{top?'Top tier':proven?'Proven tier':'no tier yet'}</div></div>
      </div>
      <section className="panel"><div className="panel-head"><span className="title">Identity</span></div>
        <p style={{margin:0}}>Current owner <code style={mono}>{data.owner}</code></p>
        {data.working&&<p style={{margin:0}}>Current working wallet <code style={mono}>{data.working}</code></p>}
        <p style={{margin:0,fontSize:13,color:'var(--ink-mute)'}}>Proven: {proven?'qualified':'not yet'} · Top: {top?'qualified':'not yet'}</p>
      </section>
      <div className="form-grid-2" style={{marginTop:22,alignItems:'stretch'}}>{data.sources.map(source=><section className="panel" style={{marginTop:0}} key={source.name}><div className="panel-head"><span className="title">{source.name} record</span></div>{source.record[2]===0n?<p style={{margin:0,color:'var(--ink-soft)'}}>No synchronized record.</p>:<><p style={{margin:0}}>{String(source.record[0])} paid jobs · score sum {String(source.record[1])} · average {average(source.record[0],source.record[1])}</p><p style={{margin:0,fontSize:13,color:'var(--ink-mute)'}}>Source block {String(source.record[2])} · updated {new Date(Number(source.record[3])*1000).toLocaleString()}</p></>}</section>)}</div>
      <p style={{fontSize:13,color:'var(--ink-mute)',marginTop:18}}>Mirrored reputation trusts our relayer for Base and Arc. Arc data is supplied by our API. Every record includes its source block for verification. {data.relayer==='0x0000000000000000000000000000000000000000'?'The trusted relayer is currently disabled.':''}</p>
    </>}
    <footer className="spacer"/>
  </>;
}
