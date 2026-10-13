/** Executes the reviewed Monad MAINNET Safe actions in nonce order from collected owner signatures.
 *  Dry-run by default (verifies signatures and simulates). --broadcast sends; --through=N executes only the first N actions
 *  (default 3 = acceptOwner, acceptArbitrator, setRelayer; use --through=4 to include setPaused(false)).
 *  The deployer only pays gas. Each action is capped at 0.1 MON. */
import {readFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,defineChain,parseAbi,hashTypedData,formatEther} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverSafeSignature} from './monad-safe-signatures.mjs';
const root=new URL('../',import.meta.url);
const payload=JSON.parse(readFileSync(new URL('contracts/cache/monad-mainnet-governance-plan.json',root),'utf8'));
const signatures=JSON.parse(readFileSync(new URL('contracts/cache/monad-mainnet-governance-signatures.json',root),'utf8'));
const deployment=JSON.parse(readFileSync(new URL('contracts/cache/monad-mainnet-deployment.json',root),'utf8'));
const broadcast=process.argv.includes('--broadcast');
const throughArg=process.argv.find(a=>a.startsWith('--through='));const through=throughArg?Number(throughArg.split('=')[1]):3;
if(!Number.isInteger(through)||through<1||through>4)throw new Error('--through must be 1-4');
if(payload.chainId!==143||payload.safe.toLowerCase()!==deployment.safe.toLowerCase()||payload.calls.length!==4)throw new Error('Unexpected governance plan');
const env=Object.fromEntries(readFileSync(new URL('.env',root),'utf8').split(/\r?\n/).filter(s=>s.includes('=')&&!s.trim().startsWith('#')).map(s=>{const i=s.indexOf('=');return[s.slice(0,i).trim(),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const account=privateKeyToAccount(env.BASE_MAINNET_DEPLOYER_KEY.startsWith('0x')?env.BASE_MAINNET_DEPLOYER_KEY:`0x${env.BASE_MAINNET_DEPLOYER_KEY}`);
if(account.address.toLowerCase()!==deployment.owner.toLowerCase())throw new Error('Unexpected deployer');
const rpc=process.env.MONAD_MAINNET_RPC_URL??'https://rpc.monad.xyz';
const chain=defineChain({id:143,name:'Monad',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const pub=createPublicClient({chain,transport:http(rpc)}),wallet=createWalletClient({account,chain,transport:http(rpc)});
const abi=parseAbi(['function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function nonce() view returns(uint256)','function paused() view returns(bool)','function owner() view returns(address)','function arbitrator() view returns(address)','function relayer() view returns(address)','function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)','function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)']);
const read=(address,functionName,args=[])=>pub.readContract({address,abi,functionName,args});
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const done={
 acceptOwner:async()=>same(await read(deployment.adapter,'owner'),payload.safe),
 acceptArbitrator:async()=>same(await read(deployment.adapter,'arbitrator'),payload.safe),
 setRelayer:async()=>same(await read(deployment.mirror,'relayer'),payload.relayer),
 setPaused:async()=>(await read(deployment.adapter,'paused'))===false,
};
try{
 if(await pub.getChainId()!==143)throw new Error('Mainnet-only executor');
 const owners=await read(payload.safe,'getOwners');
 if(await read(payload.safe,'getThreshold')!==2n||JSON.stringify(owners.map(x=>x.toLowerCase()).sort())!==JSON.stringify(payload.owners.map(x=>x.toLowerCase()).sort()))throw new Error('Safe signer set changed');
 for(const [index,call] of payload.calls.slice(0,through).entries()){
  if(await done[call.method]()){console.log(`${call.method} already completed`);continue;}
  const message={...call.message};for(const k of['value','safeTxGas','baseGas','gasPrice','nonce'])message[k]=BigInt(message[k]);
  if(message.value!==0n||message.operation!==0)throw new Error('Only zero-value Safe calls are allowed');
  const nonce=await read(payload.safe,'nonce');
  if(nonce!==message.nonce)throw new Error(`Safe nonce is ${nonce}, ${call.method} expects ${message.nonce}`);
  const hash=hashTypedData({domain:call.domain,types:call.types,primaryType:'SafeTx',message});
  const baseArgs=[message.to,message.value,message.data,message.operation,message.safeTxGas,message.baseGas,message.gasPrice,message.gasToken,message.refundReceiver];
  if(hash!==call.hash||hash!==await read(payload.safe,'getTransactionHash',[...baseArgs,message.nonce]))throw new Error('Safe hash mismatch');
  const verified=[];
  for(const [address,raw] of Object.entries(signatures[hash]??{})){
   const {signer,signature:sig}=await recoverSafeSignature(call,raw);
   if(!same(signer,address)||!owners.some(x=>same(x,signer)))throw new Error('Invalid Safe owner signature');
   verified.push({address:signer.toLowerCase(),signature:sig});
  }
  verified.sort((a,b)=>a.address.localeCompare(b.address));
  if(verified.length<2||new Set(verified.map(s=>s.address)).size!==verified.length)throw new Error(`Two distinct owner signatures required for ${call.method}`);
  const combined=`0x${verified.slice(0,2).map(s=>s.signature.slice(2)).join('')}`;
  const args=[...baseArgs,combined];
  const simulation=await pub.simulateContract({account,address:payload.safe,abi,functionName:'execTransaction',args});
  if(simulation.result!==true)throw new Error('Safe inner transaction failed');
  const estimated=await pub.estimateContractGas({account,address:payload.safe,abi,functionName:'execTransaction',args});
  const gas=estimated+(estimated+1n)/2n,gasPrice=await pub.getGasPrice();
  if(gas*gasPrice>100000000000000000n)throw new Error('Action exceeds the 0.1 MON budget');
  console.log(`${call.method}: 2 signatures verified; gas ${gas}; fee limit ${formatEther(gas*gasPrice)} MON`);
  if(!broadcast){console.log('Dry-run: later actions need this nonce executed first.');break;}
  const tx=await wallet.writeContract({...simulation.request,gas,gasPrice});
  const receipt=await pub.waitForTransactionReceipt({hash:tx});if(receipt.status!=='success')throw new Error('Safe transaction reverted');
  if(!await done[call.method]())throw new Error(`${call.method} read-back failed`);
  console.log(`${call.method} executed: ${tx}`);
 }
}catch(error){console.error((error.shortMessage??error.message??'Execution failed').replaceAll(rpc,'[RPC]'));process.exit(1);}
