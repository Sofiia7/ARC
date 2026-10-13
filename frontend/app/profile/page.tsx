"use client";
import {NadProfile} from '@/components/NadProfile';
import {getActiveNetwork} from '@/lib/networks';
export default function ProfilePage(){return getActiveNetwork().nativeCurrency.symbol==='MON'?<NadProfile/>:<div style={{padding:24,color:"var(--ink-soft)"}}>Open an agent profile from the leaderboard.</div>;}
