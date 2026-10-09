import { createConnector } from 'wagmi';
import { createPublicClient, createWalletClient, http, toHex, type Address, type Hex, type LocalAccount } from 'viem';
import type { Secp256k1SigningSession } from '@category-labs/mera';
import { getActiveNetwork } from './networks';
import { CONTRACTS } from './contracts';
import { validateMeraApproval, validateMeraTransaction } from './meraPolicy';

const SESSION_MS=10*60*1000;
let live:{session:Secp256k1SigningSession;account:LocalAccount;prf:Uint8Array;expires:number}|undefined;
export function endMeraSession(){live?.session.end();live?.prf.fill(0);live=undefined;}
function current(){if(!live||Date.now()>=live.expires){endMeraSession();throw Error('Passkey session expired. Sign in again.');}return live;}
/** PRF bytes stay in memory and never enter localStorage, IPFS or an API request. */
export async function deriveMeraContestKey(context:string){
  const secret=new Uint8Array(current().prf);
  try{return await(await import('./contestEncryption')).deriveContestKeypair(secret,context);}finally{secret.fill(0);}
}
export function hasMeraSession(){return !!live&&Date.now()<live.expires;}

export function meraConnector(mode:'create'|'recover'){
  return createConnector((config)=>{
    const network=getActiveNetwork();let timer:ReturnType<typeof setTimeout>|undefined;
    const disconnect=()=>{if(timer)clearTimeout(timer);endMeraSession();};
    const provider={
      on(){},removeListener(){},
      async request({method,params=[]}:{method:string;params?:readonly unknown[]}){
        const active=current(),account=active.account;
        if(method==='eth_accounts'||method==='eth_requestAccounts')return[account.address];
        if(method==='eth_chainId')return toHex(network.chainId);
        if(method==='wallet_switchEthereumChain'){if(Number((params[0] as {chainId:string}).chainId)!==network.chainId)throw Error('This passkey session is bound to Monad');return null;}
        const chain=config.chains[0],transport=http(network.rpcUrl),pub=createPublicClient({chain,transport});
        if(method==='personal_sign'){
          if(String(params[1]).toLowerCase()!==account.address.toLowerCase())throw Error('Passkey signer mismatch');
          const message=params[0] as Hex;
          // Every off-chain signature still requires a deliberate user action.
          if(!window.confirm(`Sign this NadBounty message?\nSigner: ${account.address}\nMessage (hex): ${message}`))throw Error('Signature cancelled');
          return account.signMessage({message:{raw:message}});
        }
        if(method==='eth_signTypedData_v4'){
          if(String(params[0]).toLowerCase()!==account.address.toLowerCase())throw Error('Passkey signer mismatch');
          const typed=JSON.parse(String(params[1]));
          if(Number(typed.domain?.chainId)!==network.chainId)throw Error('Typed data chain mismatch');
          if(!window.confirm(`Sign typed data on Monad?\nSigner: ${account.address}\n${JSON.stringify(typed,null,2)}`))throw Error('Signature cancelled');
          return account.signTypedData(typed);
        }
        if(method==='eth_sendTransaction'){
          const tx=params[0] as {from?:string;to:Address;value?:Hex;chainId?:Hex;data?:Hex;gas?:Hex;gasPrice?:Hex;maxFeePerGas?:Hex;maxPriorityFeePerGas?:Hex;nonce?:Hex};
          validateMeraTransaction(tx,{account:account.address,chainId:network.chainId,adapter:CONTRACTS.BOUNTY_ADAPTER,usdc:CONTRACTS.USDC,identity:CONTRACTS.IDENTITY_REGISTRY});
          if(tx.to.toLowerCase()===CONTRACTS.USDC.toLowerCase())validateMeraApproval(tx.data??'0x',CONTRACTS.BOUNTY_ADAPTER);
          if(await pub.getChainId()!==network.chainId)throw Error('RPC chain mismatch');
          const estimate=tx.gas?undefined:await pub.estimateGas({account,to:tx.to,data:tx.data});
          const gas=tx.gas?BigInt(tx.gas):estimate!+(estimate!+1n)/2n;
          const gasPrice=await pub.getGasPrice();
          if(gas*gasPrice>150000000000000000n)throw Error('Passkey transaction exceeds 0.15 MON gas budget');
          if(!window.confirm(`Send on ${network.name}?\nTo: ${tx.to}\nNative value: 0 MON\nGas limit: ${gas}\nMaximum gas cost: ${Number(gas*gasPrice)/1e18} MON\nData: ${tx.data??'0x'}`))throw Error('Transaction cancelled');
          return createWalletClient({chain,transport,account}).sendTransaction({to:tx.to,data:tx.data,gas,gasPrice,value:0n});
        }
        // No raw signing, arbitrary transactions, permission grants or RPC forwarding.
        throw Error(`Passkey method ${method} is not supported`);
      },
    };
    return{
      id:`nad.mera.${mode}`,name:mode==='create'?'Create a passkey wallet':'Sign in with an existing passkey',type:'mera',
      async connect<withCapabilities extends boolean=false>(parameters?:{chainId?:number;isReconnecting?:boolean;withCapabilities?:withCapabilities|boolean}){
        if(parameters?.isReconnecting)throw Error('Passkey sign-in needs a user gesture');
        if(parameters?.chainId&&parameters.chainId!==network.chainId)throw Error('Passkey chain mismatch');
        if(typeof window==='undefined'||!window.isSecureContext)throw Error('Passkeys require HTTPS or localhost');
        const {createPasskeyWithPrfOutput,getPasskeyPrfOutput}=await import('@category-labs/mera');
        const {meraIdentityFromPrf}=await import('./meraDerivation');
        const rpId=window.location.hostname,storageKey=`nadbounty:mera:credential:${rpId}`;
        const previous=localStorage.getItem(storageKey);
        if(mode==='create'&&previous)throw Error('A passkey wallet is already saved for this site. Choose sign in.');
        const result=mode==='create'?await createPasskeyWithPrfOutput({rp:{id:rpId,name:'NadBounty'},user:{name:'NadBounty wallet',displayName:'NadBounty wallet'}}):await getPasskeyPrfOutput({rpId,...(previous?{credential:JSON.parse(previous)}:{})});
        try{
          disconnect();const {session,account}=meraIdentityFromPrf(result.prfOutput);
          live={session,account,prf:new Uint8Array(result.prfOutput),expires:Date.now()+SESSION_MS};
          localStorage.setItem(storageKey,JSON.stringify({credentialId:result.credentialId}));
          timer=setTimeout(()=>{disconnect();config.emitter.emit('disconnect');},SESSION_MS);
          return{accounts:(parameters?.withCapabilities?[{address:account.address,capabilities:{}}]:[account.address]) as unknown as withCapabilities extends true?readonly{address:Address;capabilities:Record<string,unknown>}[]:readonly Address[],chainId:network.chainId};
        }catch(error){disconnect();throw error;}finally{result.prfOutput.fill(0);}
      },
      async disconnect(){disconnect();},
      async getAccounts(){return[current().account.address];},
      async getChainId(){return network.chainId;},
      async getProvider(){return provider;},
      async isAuthorized(){return false;},
      async switchChain({chainId}:{chainId:number}){if(chainId!==network.chainId)throw Error('Passkey chain mismatch');return config.chains[0];},
      onAccountsChanged(accounts:string[]){config.emitter.emit('change',{accounts:accounts as Address[]});},
      onChainChanged(chainId:string){config.emitter.emit('change',{chainId:Number(chainId)});},
      onDisconnect(){disconnect();config.emitter.emit('disconnect');},
    };
  });
}
