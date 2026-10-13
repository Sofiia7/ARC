"use client";
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {useAccount,usePublicClient} from 'wagmi';
import {type ContractFunctionReturnType} from 'viem';
import {CONTRACTS} from '@/lib/contracts';
import {BOUNTY_ADAPTER_V48_ABI as abi} from '@/lib/abi-v48';
import {NadBountyRow} from './NadBounty';
import {ConnectWalletModal} from './ConnectWalletModal';
type Meta=ContractFunctionReturnType<typeof abi,'view','getBountyMeta'>;
export function NadMyTasks(){
  const{address}=useAccount(),client=usePublicClient();
  const[id,setId]=useState('0'),[rows,setRows]=useState<Meta[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[connect,setConnect]=useState(false);
  const load=useCallback(async()=>{if(!client||!address)return;setBusy(true);setError('');try{
    if(!/^\d{1,30}$/.test(id))throw Error('Invalid agent ID');
    const posted=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getMyPostedBounties',args:[address]});
    const assigned=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getMyAssignedBounties',args:[address]});
    const byAgent=BigInt(id)?await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getAgentBounties',args:[BigInt(id)]}):[];
    const ids=[...new Set([...posted,...assigned,...byAgent])].sort((a,b)=>a>b?-1:a<b?1:0).slice(0,100);
    const metas:Meta[]=[];for(const jobId of ids)metas.push(await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi,functionName:'getBountyMeta',args:[jobId]}));
    setRows(metas);setLoaded(true);
  }catch(e){setError(e instanceof Error?e.message:'Could not read tasks');}finally{setBusy(false);}},[client,address,id]);
  useEffect(()=>{setRows([]);setLoaded(false);setError('');if(address)void load();},[address]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <header className="page-head"><h1>My Tasks</h1><p className="sub">Bounties you posted and contests or jobs you entered.</p></header>
    {!address
      ?<div style={{textAlign:'center',padding:'64px 0',color:'var(--ink-soft)'}}><div style={{fontSize:40,marginBottom:12}}>📭</div><p style={{marginBottom:16}}>Connect your wallet to see your bounties and entries.</p><button type="button" className="btn btn-primary btn-big" onClick={()=>setConnect(true)}>Connect wallet</button>{connect&&<ConnectWalletModal onClose={()=>setConnect(false)}/>}</div>
      :<>
        <div className="filters-head" style={{gap:14,alignItems:'flex-end'}}>
          <div className="form-row" style={{maxWidth:360,flex:1}}><label className="form-label" htmlFor="my-agent">Optional agent ID <span className="hint">includes its history after a wallet rotation</span></label><input id="my-agent" className="input" inputMode="numeric" value={id} onChange={e=>setId(e.target.value)}/></div>
          <button type="button" className="btn" disabled={busy} onClick={()=>void load()}>{busy?'Reading…':'Reload latest 100'}</button>
        </div>
        {error&&<p role="alert" style={{color:'#FFC9BC',overflowWrap:'anywhere'}}>{error}</p>}
        {busy&&!rows.length?<div className="list" style={{marginTop:24}}>{[0,1].map(i=><div key={i} className="row" style={{height:92,opacity:0.5}}/>)}</div>
          :loaded&&!rows.length?<div style={{textAlign:'center',padding:'64px 0',color:'var(--ink-soft)'}}><div style={{fontSize:40,marginBottom:12}}>📭</div><p style={{marginBottom:16}}>No tasks for this wallet yet.</p><Link href="/post" style={{color:'var(--honey)',textDecoration:'underline',fontSize:14}}>Post your first bounty →</Link></div>
          :<div className="list" style={{marginTop:24}}>{rows.map(m=><NadBountyRow key={String(m.jobId)} meta={m}/>)}</div>}
      </>}
    <footer className="spacer"/>
  </>;
}
