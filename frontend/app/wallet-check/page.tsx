"use client";

import {useEffect,useState} from 'react';
import {useAccount,useConnect,useDisconnect,useSignMessage} from 'wagmi';
import {verifyMessage,type Address,type Hex} from 'viem';
import {deriveMeraContestKey,hasMeraSession} from '@/lib/mera';
import {encryptContestEntry,decryptContestEntry,type EncryptedContestEntry} from '@/lib/contestEncryption';
import {getActiveNetwork} from '@/lib/networks';

type Reference={version:1;domain:string;address:Address;context:string;challenge:string;publicKey:string;entry:EncryptedContestEntry;signature:Hex;createdAt:string;sessionEnded?:boolean};
type Proof={reference:Reference;recoveredAt:string;signature:Hex;checks:{sameAddress:true;sameEncryptionKey:true;decryptAfterRecovery:true;signatureVerified:true;sessionClosed:true}};
const storageKey=()=>`nadbounty:mera:check:v1:${location.hostname}`;
const button='rounded-lg bg-violet-500 px-4 py-3 disabled:opacity-40';

export default function WalletCheck(){
 const {address,connector}=useAccount(),{connectAsync,connectors}=useConnect(),{disconnectAsync}=useDisconnect(),{signMessageAsync}=useSignMessage();
 const [reference,setReference]=useState<Reference>(),[proof,setProof]=useState<Proof>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{try{const value=localStorage.getItem(storageKey());if(value){const r=JSON.parse(value) as Reference;if(r.version===1&&r.domain===location.hostname&&r.challenge.length<1000)setReference(r);}}catch{setError('Saved check is invalid. Start a new check.');}},[]);
 async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'Check failed');}finally{setBusy(false);}}
 function requireMera(){if(!address||connector?.type!=='mera'||!hasMeraSession())throw Error('Connect using the NadBounty passkey option.');return address;}
 async function connect(mode:'create'|'recover'){await run(async()=>{const selected=connectors.find(c=>c.id===`nad.mera.${mode}`);if(!selected)throw Error('Passkey connector is unavailable on this network.');await connectAsync({connector:selected});setProof(undefined);setStatus(mode==='create'?'Passkey connected. Prepare the check.':'Passkey recovered. Verify recovery.');});}
 async function prepare(){await run(async()=>{
  const owner=requireMera(),nonce=crypto.randomUUID(),context=`NadBounty passkey check v1:${owner.toLowerCase()}:${nonce}`;
  const challenge=`NadBounty passkey self-check\nDomain: ${location.hostname}\nWallet: ${owner}\nNonce: ${nonce}`;
  const key=await deriveMeraContestKey(context),entry=await encryptContestEntry(challenge,key.publicKey);
  if(await decryptContestEntry(entry,key)!==challenge)throw Error('Initial encryption check failed');
  const signature=await signMessageAsync({message:challenge});if(!await verifyMessage({address:owner,message:challenge,signature}))throw Error('Initial signature verification failed');
  const value:Reference={version:1,domain:location.hostname,address:owner,context,challenge,publicKey:key.publicKey,entry,signature,createdAt:new Date().toISOString()};
  localStorage.setItem(storageKey(),JSON.stringify(value));setReference(value);setProof(undefined);setStatus('Check prepared. End the session, then sign in with the same passkey.');
 });}
 async function close(){await run(async()=>{if(!reference)throw Error('Prepare the check first');requireMera();await disconnectAsync();if(hasMeraSession())throw Error('Signing session was not closed');const value={...reference,sessionEnded:true};localStorage.setItem(storageKey(),JSON.stringify(value));setReference(value);setStatus('Session closed. Sign in with the existing passkey.');});}
 async function recover(){await run(async()=>{
  const owner=requireMera();if(!reference?.sessionEnded||reference.domain!==location.hostname)throw Error('Prepare a check and end its session first');
  if(owner.toLowerCase()!==reference.address.toLowerCase())throw Error('Recovery returned a different wallet');
  const key=await deriveMeraContestKey(reference.context);if(key.publicKey!==reference.publicKey)throw Error('Recovery returned a different encryption key');
  if(await decryptContestEntry(reference.entry,key)!==reference.challenge)throw Error('Recovery could not decrypt the saved sample');
  if(!await verifyMessage({address:owner,message:reference.challenge,signature:reference.signature}))throw Error('Saved signature is invalid');
  const message=`NadBounty recovery verification\n${reference.challenge}`,signature=await signMessageAsync({message});
  if(!await verifyMessage({address:owner,message,signature}))throw Error('Recovered signer verification failed');
  setProof({reference,recoveredAt:new Date().toISOString(),signature,checks:{sameAddress:true,sameEncryptionKey:true,decryptAfterRecovery:true,signatureVerified:true,sessionClosed:true}});setStatus('Passed: the same wallet and encryption key recovered, the sample decrypted and both signatures verified.');
 });}
 function download(){if(!proof)return;const url=URL.createObjectURL(new Blob([JSON.stringify(proof,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='nadbounty-passkey-check.json';a.click();URL.revokeObjectURL(url);}
 if(getActiveNetwork().chainId!==10143)return <main className="p-6">This check is available on NadBounty testnet.</main>;
 return <main className="mx-auto max-w-2xl p-6 space-y-5"><h1 className="text-3xl">Проверка passkey NadBounty</h1><p>Проверим восстановление кошелька, подпись и расшифровку после выхода. MON и USDC не нужны. Все действия проходят локально в браузере.</p><p>Passkey привязан к этому домену. Для проверки используй тестовый кошелёк и тот же браузер.</p><div className="flex flex-wrap gap-3"><button className={button} disabled={busy||!!address} onClick={()=>connect('create')}>1. Создать passkey</button><button className={button} disabled={busy||!!address} onClick={()=>connect('recover')}>Войти с существующим passkey</button></div>{address&&<p className="break-all">Кошелёк: {address} · {connector?.type==='mera'?'Mera':'выбери Mera passkey'}</p>}<div className="flex flex-wrap gap-3"><button className={button} disabled={busy||connector?.type!=='mera'} onClick={prepare}>2. Подготовить проверку</button><button className={button} disabled={busy||!reference||connector?.type!=='mera'} onClick={close}>3. Завершить сессию</button><button className={button} disabled={busy||!reference?.sessionEnded||connector?.type!=='mera'} onClick={recover}>4. Проверить после входа</button></div>{reference&&<p className="text-sm">Сохранён только публичный образец: адрес, подпись и зашифрованный тестовый текст. Приватные ключи и PRF не сохраняются.</p>}{busy&&<p>Ожидаем действие в браузере…</p>}{status&&<p role="status">{status}</p>}{error&&<p role="alert" className="text-rose-300 break-words">{error}</p>}{proof&&<button className={button} onClick={download}>Скачать публичный результат</button>}</main>;
}

