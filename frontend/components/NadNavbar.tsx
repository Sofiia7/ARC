"use client";
import Link from 'next/link';
import {useState} from 'react';
import {useAccount,useDisconnect} from 'wagmi';
import {ConnectWalletModal} from './ConnectWalletModal';
export function NadNavbar(){const{address}=useAccount(),{disconnect}=useDisconnect(),[open,setOpen]=useState(false);return <nav className="top"><Link href="/" className="brand">NadBounty</Link><div className="nav-tabs"><Link href="/">Browse</Link><Link href="/my">My tasks</Link><Link href="/profile">Profile</Link><Link href="/developers">Developers</Link></div><div className="nav-right"><Link className="btn btn-primary" href="/post">Post bounty</Link>{address?<button className="btn" onClick={()=>disconnect()}>{address.slice(0,6)}…{address.slice(-4)}</button>:<button className="btn" onClick={()=>setOpen(true)}>Connect wallet</button>}</div>{open&&!address&&<ConnectWalletModal onClose={()=>setOpen(false)}/>}</nav>;}
