import {NextResponse} from 'next/server';
import {createPublicClient,http} from 'viem';
import {getActiveNetwork} from './networks';
import {CONTRACTS} from './contracts';
import {BOUNTY_ADAPTER_V48_ABI as abi} from './abi-v48';
export const nadJson=(value:unknown,status=200)=>new NextResponse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v),{status,headers:{'Content-Type':'application/json','Cache-Control':status===200?'public, max-age=15':'no-store','Access-Control-Allow-Origin':'*'}});
export async function nadApiClient(){
  const network=getActiveNetwork();if(network.nativeCurrency.symbol!=='MON')throw Error('NadBounty only');
  const client=createPublicClient({transport:http(process.env.NAD_RPC_URL??network.rpcUrl,{timeout:15000,retryCount:1})});
  if(await client.getChainId()!==network.chainId)throw Error('RPC chain mismatch');
  const block=await client.getBlock();
  return{client,block,adapter:CONTRACTS.BOUNTY_ADAPTER,abi,network,info:{chainId:network.chainId,contractVersion:'4.8',adapter:CONTRACTS.BOUNTY_ADAPTER,sourceBlock:block.number,sourceBlockHash:block.hash,testnet:network.testnet}};
}
