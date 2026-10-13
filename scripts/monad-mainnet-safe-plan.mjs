/** Prepares the four reviewed zero-value Safe actions for Monad MAINNET. Never broadcasts, never moves funds.
 *  0 acceptOwner (adapter)  1 acceptArbitrator (adapter)  2 setRelayer (mirror)  3 setPaused(false) (adapter) */
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,parseAbi,encodeFunctionData,hashTypedData,zeroAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const root=new URL('../',import.meta.url);
const parse=s=>Object.fromEntries(s.split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const deployment=JSON.parse(readFileSync(new URL('contracts/cache/monad-mainnet-deployment.json',root),'utf8'));
const prior=JSON.parse(readFileSync(new URL('contracts/cache/monad-mainnet-safe-handoff.json',root),'utf8'));
const {safe,adapter,mirror}=deployment;
const rpc=process.env.MONAD_MAINNET_RPC_URL??'https://rpc.monad.xyz';
const client=createPublicClient({transport:http(rpc,{timeout:20000,retryCount:2})});
const abi=parseAbi(['function owner() view returns(address)','function pendingOwner() view returns(address)','function relayer() view returns(address)','function forwarder() view returns(address)','function paused() view returns(bool)','function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function nonce() view returns(uint256)','function setRelayer(address)','function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)']);
const read=(address,functionName,args=[])=>client.readContract({address,abi,functionName,args});
try{
 if(await client.getChainId()!==143)throw Error('Wrong network');
 const owners=await read(safe,'getOwners');
 if(await read(safe,'getThreshold')!==2n||JSON.stringify(owners.map(a=>a.toLowerCase()).sort())!==JSON.stringify(prior.owners.map(a=>a.toLowerCase()).sort()))throw Error('Safe signer set mismatch');
 if((await read(mirror,'owner')).toLowerCase()!==safe.toLowerCase()||await read(mirror,'relayer')!==zeroAddress||await read(mirror,'forwarder')!==zeroAddress)throw Error('Expected Safe-owned mirror with disabled writers');
 if(!await read(adapter,'paused'))throw Error('Adapter must still be paused when the plan is prepared');
 if((await read(adapter,'pendingOwner')).toLowerCase()!==safe.toLowerCase())throw Error('Safe is not the pending adapter owner');
 const baseNonce=await read(safe,'nonce');
 if(baseNonce!==0n)throw Error('Safe nonce is not 0; plan would not match reviewed order');
 const relayerKey=parse(readFileSync(new URL('.env.nad-mainnet-relayer',root),'utf8')).NAD_MAINNET_REPUTATION_RELAYER_PRIVATE_KEY;
 const relayer=privateKeyToAccount(relayerKey).address;
 if(owners.some(a=>a.toLowerCase()===relayer.toLowerCase()))throw Error('Relayer must differ from Safe owners');
 const types=prior.calls[0].types,domain={chainId:143,verifyingContract:safe};
 const spec=[
  ['acceptOwner',adapter,encodeFunctionData({abi:parseAbi(['function acceptOwner()']),functionName:'acceptOwner'})],
  ['acceptArbitrator',adapter,encodeFunctionData({abi:parseAbi(['function acceptArbitrator()']),functionName:'acceptArbitrator'})],
  ['setRelayer',mirror,encodeFunctionData({abi,functionName:'setRelayer',args:[relayer]})],
  ['setPaused',adapter,encodeFunctionData({abi:parseAbi(['function setPaused(bool)']),functionName:'setPaused',args:[false]})],
 ];
 const calls=[];
 for(const [i,[method,to,data]] of spec.entries()){
  const nonce=baseNonce+BigInt(i);
  const message={to,value:0n,data,operation:0,safeTxGas:0n,baseGas:0n,gasPrice:0n,gasToken:zeroAddress,refundReceiver:zeroAddress,nonce};
  const hash=hashTypedData({domain,types,primaryType:'SafeTx',message});
  const onchain=await read(safe,'getTransactionHash',[to,0n,data,0,0n,0n,0n,zeroAddress,zeroAddress,nonce]);
  if(hash!==onchain)throw Error(`Safe hash mismatch for ${method}`);
  calls.push({method,hash,domain,types,message:Object.fromEntries(Object.entries(message).map(([k,v])=>[k,typeof v==='bigint'?String(v):v]))});
 }
 await client.simulateContract({address:mirror,abi,functionName:'setRelayer',args:[relayer],account:safe});
 const plan={chainId:143,safe,adapter,mirror,relayer,requiredSignatures:2,owners,calls,broadcast:false,
  authority:'setRelayer: trusted Base/Arc reputation writer only. setPaused(false): opens new bounties; settlement and withdrawals work regardless.'};
 writeFileSync(new URL('contracts/cache/monad-mainnet-governance-plan.json',root),JSON.stringify(plan,null,2));
 console.log(JSON.stringify({safe,adapter,mirror,relayer,calls:calls.map(c=>({method:c.method,nonce:c.message.nonce,hash:c.hash})),broadcast:false},null,2));
}catch(error){console.error(JSON.stringify({message:error instanceof Error?error.message:'plan failed',note:'no transaction broadcast'}));process.exitCode=1;}
