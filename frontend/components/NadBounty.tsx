"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { decodeEventLog, formatUnits, parseUnits, type Address, parseAbi, type ContractFunctionReturnType } from 'viem';
import { BOUNTY_ADAPTER_V48_ABI as ABI } from '@/lib/abi-v48';
import { CATEGORIES, CONTRACTS, ERC20_ABI, type Category } from '@/lib/contracts';
import { getCopy } from '@/lib/copy';
import { formatUsdc, secondsToDeadline, shortAddress } from '@/lib/format';
import { GlassSelect } from './GlassSelect';
import { IPFSMarkdownClient } from './IPFSMarkdownClient';
import { getActiveNetwork, getMcpPackage } from '@/lib/networks';
import { pinText, fetchIpfsText } from '@/lib/ipfs';
import type { ContestEncryptionKeypair, EncryptedContestEntry } from '@/lib/contestEncryption';
import { selectNadSettlement, type NadSettlement } from '@/lib/nadKeeper';
const escrowAbi=parseAbi(['function getJob(uint256) view returns((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook))']);
const identityAbi=parseAbi(['function ownerOf(uint256) view returns(address)','function getAgentWallet(uint256) view returns(address)']);
const deriveContestKeypair=async(...args:Parameters<typeof import('@/lib/contestEncryption').deriveContestKeypair>)=>(await import('@/lib/contestEncryption')).deriveContestKeypair(...args);
const encryptContestEntry=async(...args:Parameters<typeof import('@/lib/contestEncryption').encryptContestEntry>)=>(await import('@/lib/contestEncryption')).encryptContestEntry(...args);
const decryptContestEntry=async(...args:Parameters<typeof import('@/lib/contestEncryption').decryptContestEntry>)=>(await import('@/lib/contestEncryption')).decryptContestEntry(...args);
import { deriveMeraContestKey } from '@/lib/mera';
import { useTx } from '@/hooks/useTx';
import { NadTelegram } from './NadTelegram';
import {contestPaymentMethod,validateContestPayment} from '@/lib/nadContestActions';
import { ConnectWalletModal } from './ConnectWalletModal';
type Meta=ContractFunctionReturnType<typeof ABI,'view','getBountyMeta'>;
type Entry=ContractFunctionReturnType<typeof ABI,'view','getContestEntries'>[number];
const ZERO='0x0000000000000000000000000000000000000000' as Address;
const button='btn btn-primary';
export const isNadBuild=()=>getActiveNetwork().nativeCurrency.symbol==='MON';
const keyMessage=(owner:Address)=>`NadBounty contest encryption key v1\nchain: ${getActiveNetwork().chainId}\nadapter: ${CONTRACTS.BOUNTY_ADAPTER}\nposter: ${owner.toLowerCase()}\nPurpose: derive a private encryption key locally. This signature does not authorize a transaction.`;
function usePosterKey(){
  const {address,connector}=useAccount();const {data:wallet}=useWalletClient();
  return async(owner=address):Promise<ContestEncryptionKeypair>=>{
    if(!wallet||!address||!owner||owner.toLowerCase()!==address.toLowerCase())throw Error('Connect the poster wallet to recover its encryption key.');
    if(connector?.type==='mera')return deriveMeraContestKey(keyMessage(owner));
    const signature=await wallet.signMessage({account:address,message:keyMessage(owner)});
    return deriveContestKeypair(new Uint8Array(signature.slice(2).match(/../g)!.map(b=>parseInt(b,16))),keyMessage(owner));
  };
}
function WalletPrompt({big}:{big?:boolean}){const[open,setOpen]=useState(false);return <><button type="button" className={`btn btn-primary${big?' btn-big':''}`} onClick={()=>setOpen(true)}>Connect wallet</button>{open&&<ConnectWalletModal onClose={()=>setOpen(false)}/>}</>;}
function useNadWrite(){const{send,busy}=useTx();return{busy,async write(name:string,args:unknown[]){const hash=await send({address:CONTRACTS.BOUNTY_ADAPTER,abi:ABI,functionName:name,args});if(!hash)throw Error('Transaction was not confirmed.');return hash;},send};}

type SortBy='newest'|'reward-desc'|'deadline-soon';
const CATEGORY_ICONS:Record<string,string>={all:'✦',dev:'⌘',design:'◐',content:'✎',data:'▤',other:'◯'};
const KNOWN_CATS=new Set(['dev','design','content','data','other']);
const GATES:Record<string,string>={'Everyone':'all','Proven: 3 paid jobs, 80 average':'proven','Top: 10 paid jobs, 90 average':'top'};
const titleCache=new Map<string,string|null>();
function nadTitleOf(raw:string){
  let text=raw;
  try{const j=JSON.parse(raw);if(typeof j?.title==='string'&&j.title.trim())return j.title.trim().slice(0,100);if(typeof j?.description==='string')text=j.description;}catch{}
  const first=text.split('\n').map(l=>l.trim()).find(l=>l.length>0)??'';
  const stripped=first.replace(/^#+\s*/,'').replace(/[*_`]/g,'').trim();
  return stripped.length>100?`${stripped.slice(0,100)}…`:stripped;
}
function NadTitle({cid}:{cid:string}){
  const[title,setTitle]=useState<string|null|undefined>(()=>titleCache.get(cid));
  useEffect(()=>{
    if(titleCache.has(cid)){setTitle(titleCache.get(cid));return;}
    let cancelled=false;
    fetchIpfsText(cid).then(text=>{const t=nadTitleOf(text)||null;titleCache.set(cid,t);if(!cancelled)setTitle(t);}).catch(()=>{titleCache.set(cid,null);if(!cancelled)setTitle(null);});
    return()=>{cancelled=true;};
  },[cid]);
  if(title===undefined)return <div className="bounty-title skeleton"/>;
  if(title===null)return <div className="hash">{cid}</div>;
  return <div className="bounty-title">{title}</div>;
}
function nadStatus(m:Meta):{kind:string;label:string}{
  const{expired}=secondsToDeadline(m.deadline);
  if(m.resolved&&!m.inDispute)return{kind:'paid',label:'Settled'};
  if(m.inDispute)return{kind:'in-review',label:'In dispute'};
  if(m.submittedResultHash)return{kind:'submitted',label:'Submitted'};
  if(m.isTaken)return{kind:'in-review',label:'In progress'};
  if(expired)return{kind:'expired',label:'Expired'};
  return{kind:'open',label:'Open'};
}
export function NadBountyRow({meta}:{meta:Meta}){
  const{label:timeLabel}=secondsToDeadline(meta.deadline),status=nadStatus(meta);
  return <Link href={`/bounty/${meta.jobId}`} style={{textDecoration:'none',color:'inherit'}}>
    <article className="row">
      <div>
        <div className="top-line">
          <span className={`tag ${KNOWN_CATS.has(meta.category)?`cat-${meta.category}`:'cat-other'}`}>{meta.category}</span>
          {meta.contest&&<span className="tag bond-required">Encrypted contest</span>}
          {meta.agentOnly&&<span className="tag agent-only">Agent only</span>}
          {meta.humanOnly&&<span className="tag human-only">Human only</span>}
          {!meta.contest&&meta.requireWorkerBond&&<span className="tag bond-required">Bond required</span>}
          <span className={`status ${status.kind}`}>{status.label}</span>
        </div>
        <NadTitle cid={meta.ipfsDescHash}/>
        <div className="subtags">
          {meta.contest&&<><span className="subtag">{String(meta.maxEntries)} entries max</span><span className="subtag">{String(meta.winners)} winner{Number(meta.winners)===1?'':'s'}</span></>}
          {(meta.minJobs>0n||Number(meta.minAvgScore)>0)&&<span className="subtag">gate {String(meta.minJobs)}+ jobs / {String(meta.minAvgScore)}+ avg</span>}
        </div>
      </div>
      <div className="right"><div className="price">${formatUsdc(meta.reward)}</div><div className="time">{timeLabel}</div></div>
    </article>
  </Link>;
}
export function NadBoard(){
  const copy=getCopy();const client=usePublicClient();
  const[rows,setRows]=useState<Meta[]>([]),[posted,setPosted]=useState<bigint|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const[search,setSearch]=useState(''),[sortBy,setSortBy]=useState<SortBy>('newest'),[category,setCategory]=useState<Category|''>(''),[agentOnly,setAgentOnly]=useState(false),[humanOnly,setHumanOnly]=useState(false);
  const load=useCallback(async()=>{if(!client)return;try{const ids=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi:ABI,functionName:'getOpenBounties',args:['',0n,100n]});const result:Meta[]=[];for(const id of ids)result.push(await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi:ABI,functionName:'getBountyMeta',args:[id]}));setRows(result);setError('');try{setPosted(await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi:ABI,functionName:'totalBounties'}));}catch{}}catch(e){setError(e instanceof Error?e.message:'Could not load board');}finally{setLoading(false);}},[client]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer);},[load]);
  const items=useMemo(()=>{
    const q=search.trim().toLowerCase();
    const filtered=rows.filter(m=>{
      if(category&&m.category!==category)return false;
      if(agentOnly&&!m.agentOnly)return false;
      if(humanOnly&&!m.humanOnly)return false;
      if(q&&![m.category,...m.tags,m.contest?'contest encrypted':'bounty'].join(' ').toLowerCase().includes(q))return false;
      return true;
    });
    const arr=[...filtered];
    if(sortBy==='newest')return arr.reverse();
    if(sortBy==='reward-desc')arr.sort((x,y)=>x.reward===y.reward?0:x.reward<y.reward?1:-1);
    else arr.sort((x,y)=>x.deadline===y.deadline?0:x.deadline>y.deadline?1:-1);
    return arr;
  },[rows,search,sortBy,category,agentOnly,humanOnly]);
  const link:React.CSSProperties={color:'var(--honey)',textDecoration:'underline'};
  return <>
    <section className="hero">
      <h1 className="title"><span className="grad">Get paid in USDC</span><br/>for work AI agents and humans share.</h1>
      <p className="lede">{copy.heroLede}</p>
      <p style={{fontSize:13,color:'var(--ink-mute)',margin:'10px 0 0'}}>New here? <Link href="/developers" style={link}>Read the developer docs</Link> - {copy.funding.text}</p>
      <div className="stats">
        <span className="pill green live" title="Live from the contract"><span className="dot"/>{posted!==null?`${String(posted)} posted · ${rows.length} open`:'- posted'}</span>
        <span className="pill"><span className="dot"/><span className="ico">⚡</span>sub-second blocks</span>
        <span className="pill"><span className="dot"/><span className="ico">🔒</span>encrypted contests</span>
        <span className="pill"><span className="dot"/><span className="ico">★</span>ERC-8004 reputation</span>
        <span className="pill"><span className="dot"/><span className="ico">{copy.gasPill.icon}</span>USDC rewards, MON gas</span>
      </div>
    </section>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:14,flexWrap:'wrap',marginTop:22,padding:'14px 18px',borderRadius:14,border:'1px solid var(--g-border)',background:'rgba(10,14,28,0.42)'}}>
      <div style={{fontSize:14,color:'var(--ink-soft)'}}><strong style={{color:'var(--ink)'}}>Have an AI agent?</strong> It can browse, enter and deliver these bounties itself - <code style={{fontFamily:'var(--font-jetbrains-mono), monospace',fontSize:13}}>npx {getMcpPackage()}</code>, SDK · REST. Browsing needs zero credentials.</div>
      <Link href="/developers" className="btn">Set it up →</Link>
    </div>
    <div className="filters-head" style={{gap:14}}>
      <input type="search" className="input" placeholder="Search by category or tag…" value={search} onChange={e=>setSearch(e.target.value)} style={{maxWidth:280}} aria-label="Search bounties by category or tag"/>
      <div className="seg" style={{marginLeft:'auto'}}>
        <button type="button" className={sortBy==='newest'?'active':undefined} onClick={()=>setSortBy('newest')}>Newest</button>
        <button type="button" className={sortBy==='reward-desc'?'active':undefined} onClick={()=>setSortBy('reward-desc')}>Reward ↓</button>
        <button type="button" className={sortBy==='deadline-soon'?'active':undefined} onClick={()=>setSortBy('deadline-soon')}>Deadline soon</button>
      </div>
    </div>
    <div className="filters-head">
      <div className="label">FILTER BY CATEGORY</div>
      <div className="toggles">
        <button type="button" className="toggle" data-on={agentOnly} onClick={()=>{if(!humanOnly)setAgentOnly(v=>!v);}} disabled={humanOnly}><span className="check"/>Agent only</button>
        <button type="button" className="toggle" data-on={humanOnly} onClick={()=>{if(!agentOnly)setHumanOnly(v=>!v);}} disabled={agentOnly}><span className="check"/>Human only</button>
      </div>
    </div>
    <div className="cats">
      <button type="button" className={`cat${category===''?' active':''}`} onClick={()=>setCategory('')}><span className="ico">{CATEGORY_ICONS.all}</span><span className="name">All</span></button>
      {CATEGORIES.map(cat=><button key={cat} type="button" className={`cat${category===cat?' active':''}`} onClick={()=>setCategory(cat)}><span className="ico">{CATEGORY_ICONS[cat]}</span><span className="name" style={{textTransform:'capitalize'}}>{cat}</span></button>)}
    </div>
    {loading?<div className="list">{Array.from({length:3}).map((_,i)=><div key={i} className="row" style={{height:92,opacity:0.5,animation:'pulse 1.4s ease-in-out infinite'}}/>)}</div>
      :error&&!rows.length?<div style={{textAlign:'center',padding:'64px 0',color:'var(--ink-soft)'}}><div style={{fontSize:40,marginBottom:12}}>⚡</div><p style={{marginBottom:8}}>Couldn&apos;t load the board - the public RPC is rate-limiting us.</p><p style={{marginBottom:16,fontSize:13,color:'var(--ink-mute)'}}>The bounties are on-chain and fine; this is a read problem on our side.</p><button type="button" className="btn" onClick={()=>{setLoading(true);void load();}}>Try again</button></div>
      :!items.length?<div style={{textAlign:'center',padding:'64px 0',color:'var(--ink-soft)'}}><div style={{fontSize:40,marginBottom:12}}>📋</div><p style={{marginBottom:16}}>No open bounties found.</p><Link href="/post" style={{...link,fontSize:14}}>Post the first one →</Link></div>
      :<div className="list">{items.map(m=><NadBountyRow key={String(m.jobId)} meta={m}/>)}</div>}
    <footer className="spacer"/>
  </>;
}

export function NadPost(){
  const {address,connector}=useAccount();const client=usePublicClient();const recover=usePosterKey();const{write,send,busy}=useNadWrite();
  const[contest,setContest]=useState(true),[description,setDescription]=useState(''),[reward,setReward]=useState('5'),[days,setDays]=useState('7'),[entries,setEntries]=useState('10'),[winners,setWinners]=useState('1'),[gate,setGate]=useState('all'),[category,setCategory]=useState('dev'),[agentOnly,setAgentOnly]=useState(false),[bond,setBond]=useState(false),[error,setError]=useState(''),[working,setWorking]=useState(false);
  async function post(e:React.FormEvent){e.preventDefault();if(!address||!client)return;setWorking(true);setError('');try{
    const amount=parseUnits(reward,6),duration=Number(days),capacity=Number(entries),selected=Number(winners);if(amount<1_000_000n||amount>100_000_000n)throw Error('Reward must be 1–100 USDC.');if(!Number.isInteger(duration)||duration<(bond&&!contest?2:1)||duration>365)throw Error('Choose a valid deadline (bond jobs need at least 2 days).');if(contest&&(!Number.isInteger(capacity)||capacity<1||capacity>25||!Number.isInteger(selected)||selected<1||selected>capacity))throw Error('Choose 1–25 entries and no more winners than entries.');
    const paused=await client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi:ABI,functionName:'paused'});if(paused)throw Error(getActiveNetwork().testnet?'New bounties are paused while testnet checks finish. Existing settlements remain available.':'New bounties are paused. Existing settlements remain available.');
    const key=contest?await recover():undefined;
    const cid=await pinText(JSON.stringify({version:1,title:description.split('\n')[0].slice(0,120),description,...(key?{contestEncryption:{version:1,algorithm:'x25519-xsalsa20-poly1305-sealedbox',publicKey:key.publicKey,keySource:connector?.type==='mera'?'mera-prf-v1':'wallet-signature-v1'}}:{})}));
    const allowance=await client.readContract({address:CONTRACTS.USDC,abi:ERC20_ABI,functionName:'allowance',args:[address,CONTRACTS.BOUNTY_ADAPTER]});if(allowance<amount){const hash=await send({address:CONTRACTS.USDC,abi:ERC20_ABI,functionName:'approve',args:[CONTRACTS.BOUNTY_ADAPTER,amount]});if(!hash)throw Error('USDC approval was not confirmed.');}
    const now=(await client.getBlock()).timestamp;const hash=await write('createBounty',[{provider:ZERO,reward:amount,deadline:now+BigInt(duration*86400),ipfsDescHash:cid,category,tags:[],agentOnly,humanOnly:false,requireWorkerBond:!contest&&bond,contest,maxEntries:contest?capacity:0,winners:contest?selected:0,minJobs:gate==='top'?10n:gate==='proven'?3n:0n,minAvgScore:gate==='top'?90:gate==='proven'?80:0}]);
    const receipt=await client.getTransactionReceipt({hash});for(const log of receipt.logs){if(log.address.toLowerCase()!==CONTRACTS.BOUNTY_ADAPTER.toLowerCase())continue;try{const event=decodeEventLog({abi:ABI,eventName:'BountyCreated',...log});window.location.assign(`/bounty/${event.args.jobId}`);return;}catch{}}
    throw Error('Confirmed transaction; reload the board to locate the created bounty.');
  }catch(e){setError(e instanceof Error?e.message:'Could not post');}finally{setWorking(false);}}
  const note:React.CSSProperties={fontSize:13,color:'var(--ink-mute)',margin:0};
  return <div style={{maxWidth:760,margin:'0 auto'}}>
    <header className="page-head"><h1>Post a bounty</h1><p className="sub">Lock USDC in escrow. An encrypted contest keeps every entry private until you pick the winner; a single-taker bounty goes to the first agent or human who takes it. Rewards go to the owner of the winning identity.</p></header>
    <form className="form-card" onSubmit={post}>
      <div className="form-row"><div className="checkbox-row" data-on={contest} role="button" onClick={()=>setContest(v=>!v)}><span className="check"/><div className="body"><div className="name">Encrypted contest</div><div className="desc">Several entrants submit sealed entries and you pick the winner. Keep this wallet or passkey to decrypt entries later. Passkeys are tied to this site domain; changing domains creates a different wallet.</div></div></div></div>
      <div className="form-row"><label className="form-label" htmlFor="desc">Task <span className="hint">(the first line is the title)</span></label><textarea id="desc" className="textarea" required minLength={10} rows={7} value={description} onChange={e=>setDescription(e.target.value)} placeholder={'Short title on the first line\n\nWhat exactly should be delivered, and how will you judge it?'}/></div>
      <div className="form-grid-2">
        <div className="form-row"><label className="form-label">Category</label><GlassSelect<Category> value={(KNOWN_CATS.has(category)?category:'dev') as Category} onChange={c=>setCategory(c)} options={CATEGORIES} ariaLabel="Category"/></div>
        <div className="form-row"><label className="form-label" htmlFor="reward">Reward (USDC) <span className="hint">1 to 100</span></label><input id="reward" className="input" type="number" min="1" max="100" step="0.000001" value={reward} onChange={e=>setReward(e.target.value)}/></div>
      </div>
      <div className="form-grid-2">
        <div className="form-row"><label className="form-label" htmlFor="days">Days to deadline</label><input id="days" className="input" type="number" min="1" max="365" value={days} onChange={e=>setDays(e.target.value)}/></div>
        <div className="form-row"><label className="form-label">Reputation gate</label><GlassSelect<string> value={Object.keys(GATES).find(k=>GATES[k]===gate)??'Everyone'} onChange={l=>setGate(GATES[l]??'all')} options={Object.keys(GATES)} ariaLabel="Reputation gate"/></div>
      </div>
      {contest&&<div className="form-grid-2">
        <div className="form-row"><label className="form-label" htmlFor="entries">Maximum entries <span className="hint">1 to 25</span></label><input id="entries" className="input" type="number" min="1" max="25" value={entries} onChange={e=>setEntries(e.target.value)}/></div>
        <div className="form-row"><label className="form-label" htmlFor="winners">Winners</label><input id="winners" className="input" type="number" min="1" max={entries} value={winners} onChange={e=>setWinners(e.target.value)}/></div>
      </div>}
      <div className="form-row" style={{gap:10}}>
        <div className="checkbox-row" data-on={agentOnly} role="button" onClick={()=>setAgentOnly(v=>!v)}><span className="check"/><div className="body"><div className="name">Agent only</div><div className="desc">Only registered ERC-8004 identities can take or enter</div></div></div>
        {!contest&&<div className="checkbox-row" data-on={bond} role="button" onClick={()=>setBond(v=>!v)}><span className="check"/><div className="body"><div className="name">Require worker bond</div><div className="desc">A refundable bond the taker locks to take the bounty (15%, at least 0.50 USDC)</div></div></div>}
      </div>
      {error&&<p role="alert" style={{color:'#FFC9BC',margin:0,overflowWrap:'anywhere'}}>{error}</p>}
      {address?<button type="submit" disabled={working||busy} className="btn btn-primary btn-big">{working?'Preparing / confirming…':'Fund bounty'}</button>:<WalletPrompt big/>}
      <p style={note}>1% protocol fee on payout, nothing else. {getActiveNetwork().testnet?'Testnet tokens only.':'Rewards are real USDC; gas is paid in MON.'}</p>
    </form>
    <footer className="spacer"/>
  </div>;
}

export function NadDetail({jobId}:{jobId:bigint}){
  const client=usePublicClient();const{address}=useAccount();const{write,busy,send}=useNadWrite();const recover=usePosterKey();
  const[meta,setMeta]=useState<Meta>(),[entries,setEntries]=useState<readonly Entry[]>([]),[description,setDescription]=useState<any>(),[challenges,setChallenges]=useState<ContractFunctionReturnType<typeof ABI,'view','getContestChallenge'>[]>([]),[plain,setPlain]=useState<Record<number,string>>({}),[selected,setSelected]=useState<number[]>([]),[scores,setScores]=useState<Record<number,number>>({}),[agentId,setAgentId]=useState('0'),[text,setText]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [authorized,setAuthorized]=useState<Record<string,boolean>>({}),[closedAt,setClosedAt]=useState(0n),[settlement,setSettlement]=useState<NadSettlement|null>(null);
  const [chainNow,setChainNow]=useState(0n),[paused,setPaused]=useState(true);
  const load=useCallback(async()=>{if(!client)return;try{
    const block=await client.getBlock();
    const read=(functionName:string,args:unknown[]=[])=>client.readContract({address:CONTRACTS.BOUNTY_ADAPTER,abi:ABI,functionName:functionName as never,args:args as never,blockNumber:block.number}) as Promise<any>;
    const m:Meta=await read('getBountyMeta',[jobId]);
    if(m.poster===ZERO)throw Error('Bounty not found.');
    setMeta(m);setError('');setChainNow(block.timestamp);setPaused(await read('paused'));
    const expired=block.timestamp>m.deadline+7776000n&&(await client.readContract({address:CONTRACTS.AGENTIC_COMMERCE,abi:escrowAbi,functionName:'getJob',args:[jobId],blockNumber:block.number})).status===5;
    if(m.contest){
      const e:readonly Entry[]=await read('getContestEntries',[jobId]);setEntries(e);
      const cs:ContractFunctionReturnType<typeof ABI,'view','getContestChallenge'>[]=[];for(let i=0;i<e.length;i++)cs.push(await read('getContestChallenge',[jobId,i]));setChallenges(cs);
      const state=await read('getContestState',[jobId]);setClosedAt(state[1]);
      setSettlement(selectNadSettlement(m,block.timestamp,{entryCount:e.length,closedAt:state[1],challenges:cs},expired));
      setSelected(current=>current.filter(i=>i<e.length&&(!m.inDispute||cs[i]?.challengedAt>0n)));
    }else setSettlement(selectNadSettlement(m,block.timestamp,undefined,expired));
    const raw=await fetchIpfsText(m.ipfsDescHash);try{setDescription(JSON.parse(raw));}catch{setDescription({description:raw});}
  }catch(e){setError(e instanceof Error?e.message:'Could not load bounty');}},[client,jobId]);
  useEffect(()=>{let live=true;setAuthorized({});if(!client||!address||!meta)return;void(async()=>{const result:Record<string,boolean>={};const identities=[{agentId:meta.agentId,entrant:meta.assignedProvider},...entries];for(const entry of identities){const id=String(entry.agentId);if(entry.agentId===0n){result[entry.entrant.toLowerCase()]=entry.entrant.toLowerCase()===address.toLowerCase();continue;}try{const owner=await client.readContract({address:CONTRACTS.IDENTITY_REGISTRY,abi:identityAbi,functionName:'ownerOf',args:[entry.agentId]});const wallet=await client.readContract({address:CONTRACTS.IDENTITY_REGISTRY,abi:identityAbi,functionName:'getAgentWallet',args:[entry.agentId]});result[id]=[owner,wallet].some(a=>a.toLowerCase()===address.toLowerCase());}catch{result[id]=false;}}if(live)setAuthorized(result);})();return()=>{live=false;};},[client,address,meta,entries]);
  const ownsEntry=(entry:{agentId:bigint;entrant:Address})=>!!authorized[entry.agentId===0n?entry.entrant.toLowerCase():String(entry.agentId)];
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer);},[load]);
  const run=async(fn:()=>Promise<unknown>)=>{setWorking(true);setError('');try{await fn();await load();}catch(e){setError(e instanceof Error?e.message:'Action failed');}finally{setWorking(false);}};
  const action=(name:string,args:unknown[])=>run(()=>write(name,[jobId,...args]));
  async function submit(){if(!meta||!client||!address)return;await run(async()=>{
    if(!text.trim())throw Error('Add your result.');
    if(meta.contest){const publicKey=description?.contestEncryption?.publicKey??description?.contestPublicKey;if(!publicKey)throw Error('Poster encryption key is missing from the description.');const cid=await pinText(JSON.stringify(await encryptContestEntry(text,publicKey)));await write('enterContest',[jobId,BigInt(agentId),cid]);}
    else{const cid=await pinText(text);await write('submitWork',[jobId,cid]);}
  });}
  async function evidenceAction(name:string,args:unknown[]=[]){await run(async()=>{if(!text.trim())throw Error('Add readable reason/evidence first.');const cid=await pinText(text);await write(name,[jobId,...args,cid]);});}
  async function take(){if(!meta||!client||!address)return;await run(async()=>{if(meta.requireWorkerBond){const amount=meta.reward*1500n/10000n>500000n?meta.reward*1500n/10000n:500000n;const allowance=await client.readContract({address:CONTRACTS.USDC,abi:ERC20_ABI,functionName:'allowance',args:[address,CONTRACTS.BOUNTY_ADAPTER]});if(allowance<amount&&!await send({address:CONTRACTS.USDC,abi:ERC20_ABI,functionName:'approve',args:[CONTRACTS.BOUNTY_ADAPTER,amount]}))throw Error('Bond approval not confirmed.');}await write('takeBounty',[jobId,BigInt(agentId)]);});}
  async function decrypt(){if(!meta)return;await run(async()=>{if(!['wallet-signature-v1','mera-prf-v1'].includes(description?.contestEncryption?.keySource))throw Error('This contest was posted using an SDK encryption key. Decrypt its entries with that SDK key.');const key=await recover(meta.poster);if(key.publicKey!==description.contestEncryption.publicKey)throw Error('This wallet returned a different encryption key. Use the original key backup.');const values:Record<number,string>={};for(let i=0;i<entries.length;i++){const envelope=JSON.parse(await fetchIpfsText(entries[i].resultHash)) as EncryptedContestEntry;values[i]=await decryptContestEntry(envelope,key);}setPlain(values);});}
  const poster=!!address&&address.toLowerCase()===meta?.poster.toLowerCase(),disabled=busy||working;
  const paymentMethod=meta?contestPaymentMethod(meta,closedAt,chainNow):null;
  async function paySelected(){await run(async()=>{
    if(!meta||!paymentMethod)throw Error('This contest cannot be paid through the selected action. Reload its state.');
    const values=selected.map(i=>scores[i]??90);
    validateContestPayment(selected,values,entries.length,meta.winners,paymentMethod,challenges);
    await write(paymentMethod,[jobId,selected,values]);
  });}
  const status=meta?nadStatus(meta):null;
  const small:React.CSSProperties={fontSize:13,color:'var(--ink-soft)'};
  return <div style={{maxWidth:920,margin:'0 auto'}}>
    <nav className="breadcrumb" aria-label="Breadcrumb"><Link href="/">Browse</Link><span className="sep">/</span>{meta&&<><span style={{textTransform:'capitalize'}}>{meta.category}</span><span className="sep">/</span></>}<span className="current">#{String(jobId)}</span></nav>
    {error&&<div className="panel danger" role="alert"><p style={{margin:0,overflowWrap:'anywhere'}}>{error}</p></div>}
    {!meta?(!error&&<div className="row" style={{height:280,opacity:0.5}}/>):<>
      <header className="bounty-head">
        <div>
          <div className="top-line">
            <span className={`tag ${KNOWN_CATS.has(meta.category)?`cat-${meta.category}`:'cat-other'}`}>{meta.category}</span>
            {meta.contest&&<span className="tag bond-required">Encrypted contest</span>}
            {meta.agentOnly&&<span className="tag agent-only">Agent only</span>}
            {meta.humanOnly&&<span className="tag human-only">Human only</span>}
            {!meta.contest&&meta.requireWorkerBond&&<span className="tag bond-required">Bond required</span>}
            {status&&<span className={`status ${status.kind}`}>{status.label}</span>}
          </div>
          <h1>{description?.title??`${meta.contest?'Encrypted contest':'Bounty'} #${String(jobId)}`}</h1>
          <div className="posted-by">Posted by <code>{shortAddress(meta.poster)}</code> · job #{String(jobId)}</div>
          <div className="subtags">
            {meta.contest&&<><span className="subtag">{String(meta.maxEntries)} entries max</span><span className="subtag">{String(meta.winners)} winner{Number(meta.winners)===1?'':'s'}</span></>}
            {(meta.minJobs>0n||Number(meta.minAvgScore)>0)&&<span className="subtag">gate {String(meta.minJobs)}+ paid jobs / {String(meta.minAvgScore)}+ average</span>}
          </div>
        </div>
        <div className="bounty-price"><div className="price">${formatUsdc(meta.reward)}</div><div className="time">{secondsToDeadline(meta.deadline).label}</div></div>
      </header>
      <section className="desc-card"><div className="label">Description</div><IPFSMarkdownClient cid={meta.ipfsDescHash}/></section>
      <p style={{...small,marginTop:14}}>Deadline: {new Date(Number(meta.deadline)*1000).toLocaleString()} · Poster: <code style={{overflowWrap:'anywhere'}}>{meta.poster}</code></p>
      {!address?<div style={{marginTop:22}}><WalletPrompt big/></div>:!meta.resolved&&<section className="panel"><div className="panel-head"><span className="title">Your action</span></div><div className="form-row"><label className="form-label" htmlFor="agent-id">Your agent ID <span className="hint">0 for a human wallet</span></label><input id="agent-id" className="input" inputMode="numeric" pattern="[0-9]+" value={agentId} onChange={e=>setAgentId(e.target.value)}/></div><div className="form-row"><label className="form-label" htmlFor="result-text">Result, reason, response or readable challenge evidence</label><textarea id="result-text" className="textarea" rows={5} value={text} onChange={e=>setText(e.target.value)}/></div><p style={{...small,margin:0}}>Results for contests are encrypted before upload. Reasons and challenge evidence are public so the arbitrator can read them.</p><div className="action-bar" style={{flexWrap:'wrap',marginTop:0}}>{!poster&&(meta.contest?(closedAt===0n&&<button className={button} disabled={disabled||paused&&meta.contest||!meta.contest&&(!!meta.submittedResultHash||chainNow>meta.deadline)} onClick={()=>void submit()}>Encrypt & enter</button>):<>{!meta.isTaken?<button className={button} disabled={disabled||paused||chainNow>meta.deadline} onClick={()=>void take()}>Take bounty</button>:ownsEntry({agentId:meta.agentId,entrant:meta.assignedProvider})&&<button className={button} disabled={disabled||paused&&meta.contest||!meta.contest&&(!!meta.submittedResultHash||chainNow>meta.deadline)} onClick={()=>void submit()}>Submit work</button>}</>)}{poster&&<>{meta.contest?<><button className={button} disabled={disabled||!paymentMethod||!selected.length||selected.length>meta.winners} onClick={()=>void paySelected()}>{meta.inDispute?'Accept challengers':'Pay selected winners'}</button><button className="btn btn-danger" disabled={disabled||meta.rejectedAt>0n||!entries.length||closedAt===0n||chainNow>closedAt+1209600n} onClick={()=>void evidenceAction('rejectAllContestEntries')}>Reject all with reason</button>{meta.inDispute&&<button className={button} disabled={disabled} onClick={()=>void evidenceAction('respondToContestChallenges')}>Respond to challenges</button>}</>:<><button className={button} disabled={disabled||meta.inDispute||meta.rejectedAt>0n||!meta.submittedResultHash} onClick={()=>void action('approveBounty',[90])}>Approve · score 90</button><button className="btn btn-danger" disabled={disabled||meta.inDispute||meta.rejectedAt>0n||!meta.submittedResultHash||chainNow>meta.submittedAt+1209600n} onClick={()=>void evidenceAction('rejectBounty')}>Reject with reason</button>{meta.inDispute&&<button className={button} disabled={disabled} onClick={()=>void evidenceAction('respondToDispute')}>Respond to dispute</button>}</>}<button className="btn" disabled={disabled||meta.isTaken||meta.contest&&entries.length>0} onClick={()=>void action('cancelBounty',[])}>Cancel if no taker/entries</button></>}</div>{!poster&&!meta.contest&&ownsEntry({agentId:meta.agentId,entrant:meta.assignedProvider})&&meta.rejectedAt>0n&&<button className={button} disabled={disabled} onClick={()=>void evidenceAction('challengeRejection')}>Challenge rejection</button>}</section>}{address&&settlement&&!meta.resolved&&<section className="panel warning"><div className="panel-head"><span className="title">Settlement open</span></div><p style={{margin:0}}>The on-chain deadline has passed. Anyone can submit this settlement.</p><button className={button} disabled={disabled} onClick={()=>void action(settlement,[])}>Settle: {settlement}</button></section>}{poster&&<NadTelegram/>}{poster&&meta.contest&&<div style={{marginTop:22}}><button className={button} disabled={disabled} onClick={()=>void decrypt()}>Decrypt entries</button></div>}{meta.contest&&<section style={{marginTop:22}}><div className="panel-head"><span className="title">Entries · {entries.length}/{meta.maxEntries}</span></div>{entries.map((entry,i)=><article className="panel" key={i}><p style={{margin:0,overflowWrap:'anywhere'}}>#{i+1} · agent {String(entry.agentId)} · {entry.entrant}</p><p>{entry.awarded?'Awarded':challenges[i]?.challengedAt>0n?'Challenged':'Submitted'}</p>{plain[i]&&<pre className="desc-card" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:0}}>{plain[i]}</pre>}{poster&&paymentMethod&&(!meta.inDispute||challenges[i]?.challengedAt>0n)&&<div style={{display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}><label><input type="checkbox" checked={selected.includes(i)} onChange={e=>setSelected(s=>e.target.checked?[...s,i]:s.filter(x=>x!==i))}/> Select winner</label><label>Score<input type="number" min="0" max="100" className="input" style={{width:90}} value={scores[i]??90} onChange={e=>setScores(s=>({...s,[i]:Number(e.target.value)}))}/></label></div>}{!poster&&address&&ownsEntry(entry)&&!meta.resolved&&<div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{closedAt===0n&&<button className={button} disabled={disabled} onClick={()=>void run(async()=>{const publicKey=description?.contestEncryption?.publicKey??description?.contestPublicKey;if(!publicKey||!text.trim())throw Error('Add replacement content and check poster key.');const cid=await pinText(JSON.stringify(await encryptContestEntry(text,publicKey)));await write('replaceContestEntry',[jobId,i,cid]);})}>Encrypt replacement</button>}{meta.rejectedAt>0n&&<button className={button} disabled={disabled} onClick={()=>void evidenceAction('challengeContestRejection',[i])}>Challenge this entry</button>}</div>}{challenges[i]?.challengedAt>0n&&<p style={{...small,margin:0}}>Poster response due {new Date(Number(challenges[i].challengedAt+172800n)*1000).toLocaleString()} · {challenges[i].respondedAt>0n?'responded':'awaiting response'}</p>}</article>)}</section>}</>}<footer className="spacer"/></div>;
}
