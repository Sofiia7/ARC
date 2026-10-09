"use client";
import {useState} from 'react';
import {useAccount,useWalletClient} from 'wagmi';
export function NadTelegram(){
  const{address}=useAccount(),{data:wallet}=useWalletClient();const[busy,setBusy]=useState(false),[error,setError]=useState(''),[link,setLink]=useState('');
  async function connect(){if(!address||!wallet)return;setBusy(true);setError('');setLink('');try{
    const call=async(body:unknown)=>{const r=await fetch('/api/telegram/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;};
    const challenge=await call({wallet:address});
    const signature=await wallet.signMessage({account:address,message:challenge.message});
    const result=await call({wallet:address,nonce:challenge.nonce,signature});setLink(result.url);
  }catch(e){setError(e instanceof Error?e.message:'Could not link Telegram');}finally{setBusy(false);}}
  if(!address)return null;
  return <section className="rounded-xl border border-white/15 p-4 space-y-2"><p>Get private Telegram reminders for entries, review deadlines and unanswered challenges. Sign to link this wallet, then press Start in the bot. Use /stop to unlink.</p><button className="btn" disabled={busy} onClick={()=>void connect()}>{busy?'Preparing link…':'Enable Telegram reminders'}</button>{link&&<a className="btn btn-primary" href={link} target="_blank" rel="noopener noreferrer">Open Telegram and press Start · link expires in 5 minutes</a>}{error&&<p role="alert">{error}</p>}</section>;
}
