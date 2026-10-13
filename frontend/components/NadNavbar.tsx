"use client";
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useState} from 'react';
import {useAccount,useDisconnect} from 'wagmi';
import {shortAddress} from '@/lib/format';
import {getBrand} from '@/lib/networks';
import {ConnectWalletModal} from './ConnectWalletModal';

const NAV=[
  {href:'/',label:'Browse'},
  {href:'/my',label:'My Tasks'},
  {href:'/profile',label:'Profile'},
  {href:'/developers',label:'Developers'},
];
function isActive(pathname:string|null,href:string):boolean{
  if(!pathname)return false;
  if(href==='/')return pathname==='/'||pathname.startsWith('/bounty/');
  return pathname===href||pathname.startsWith(`${href}/`);
}

export function NadNavbar(){
  const{address,isConnected}=useAccount(),{disconnect}=useDisconnect(),[open,setOpen]=useState(false),pathname=usePathname();
  return <>
    <nav className="top">
      <Link href="/" className="brand" aria-label={getBrand().name}><span className="mark"/><span className="brand-name">{getBrand().name}</span></Link>
      <div className="nav-tabs">{NAV.map(({href,label})=><Link key={href} href={href} className={isActive(pathname,href)?'active':undefined}>{label}</Link>)}</div>
      <div className="nav-right">
        <Link href="/post" className="btn btn-primary" aria-label="Post a bounty"><span className="plus">+</span><span className="nav-post-label">Post Bounty</span></Link>
        {isConnected&&address
          ?<button type="button" onClick={()=>disconnect()} className="btn wallet" title="Click to disconnect"><span className="dot"/>{shortAddress(address)}</button>
          :<button type="button" onClick={()=>setOpen(true)} className="btn btn-primary">Connect Wallet</button>}
      </div>
    </nav>
    {open&&!isConnected&&<ConnectWalletModal onClose={()=>setOpen(false)}/>}
  </>;
}
