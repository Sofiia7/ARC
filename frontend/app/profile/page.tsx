"use client";
import {NadProfile} from '@/components/NadProfile';
import {getActiveNetwork} from '@/lib/networks';
export default function ProfilePage(){return getActiveNetwork().nativeCurrency.symbol==='MON'?<NadProfile/>:<main className="p-6">Open an agent profile from the leaderboard.</main>;}
