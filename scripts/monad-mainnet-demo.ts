/** Live Monad MAINNET demo: three real-USDC scenarios (single-taker with bond, encrypted contest, contest cancel).
 *  Moves real funds, so it needs --broadcast and is run by the owner of the wallets. The deployer must still own the adapter
 *  (run it BEFORE the Safe handoff); it unpauses for the run and pauses again at the end. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, formatEther, formatUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NadBountyAgent, type NadBountyCreateParams } from '../agent-sdk/src/NadBountyAgent.js';
import { BOUNTY_ADAPTER_V48_ABI } from '../agent-sdk/src/abi-v48.js';
import { deriveContestKeypair, encryptContestEntry, decryptContestEntry } from '../agent-sdk/src/contestEncryption.js';
import { pinText } from '../agent-sdk/src/ipfs.js';
import { ViemSigner } from '../agent-sdk/src/signers/viemSigner.js';

const parse = (path: URL) => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .filter(s => s.includes('=') && !s.trim().startsWith('#')).map(s => { const i=s.indexOf('=');return [s.slice(0,i).trim(),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const env = parse(new URL('../.env', import.meta.url)), demo = parse(new URL('../.env.nad-mainnet-demo', import.meta.url));
const keeperAddress = privateKeyToAccount(parse(new URL('../.env.nad-mainnet-keeper', import.meta.url)).NAD_MAINNET_KEEPER_PRIVATE_KEY as Hex).address;
const relayerAddress = privateKeyToAccount(parse(new URL('../.env.nad-mainnet-relayer', import.meta.url)).NAD_MAINNET_REPUTATION_RELAYER_PRIVATE_KEY as Hex).address;
for (const name of ['PINATA_JWT','PINATA_API_KEY','PINATA_SECRET']) if(env[name]) process.env[name]=env[name];
const rpc = process.env.MONAD_MAINNET_RPC_URL ?? 'https://rpc.monad.xyz';
const chain=defineChain({id:143,name:'Monad',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const pub=createPublicClient({chain,transport:http(rpc,{timeout:30000,retryCount:2})});
const deployment=JSON.parse(readFileSync(new URL('../contracts/cache/monad-mainnet-deployment.json',import.meta.url),'utf8'));
const adapter=deployment.adapter as Address;
const posterKey=env.BASE_MAINNET_DEPLOYER_KEY as Hex, ownerKey=demo.NAD_DEMO_OWNER_KEY as Hex, workingKey=demo.NAD_DEMO_WORKER_KEY as Hex;
const posterAccount=privateKeyToAccount(posterKey),ownerAccount=privateKeyToAccount(ownerKey),workingAccount=privateKeyToAccount(workingKey);
if(posterAccount.address.toLowerCase()!=='0x6abc2b575ec66701c17dad96dda97f22b837849e')throw Error('Unexpected deployer');
const poster=new NadBountyAgent({network:'monad-mainnet',privateKey:posterKey,bountyAdapterAddress:adapter,rpcUrl:rpc});
const worker=new NadBountyAgent({network:'monad-mainnet',privateKey:workingKey,bountyAdapterAddress:adapter,rpcUrl:rpc});
const wallet=createWalletClient({account:posterAccount,chain,transport:http(rpc)});
const posterSigner=new ViemSigner(posterKey,chain,rpc),ownerSigner=new ViemSigner(ownerKey,chain,rpc);
const idAbi=parseAbi(['function register() returns(uint256)','function ownerOf(uint256) view returns(address)','function getAgentWallet(uint256) view returns(address)','function setAgentWallet(uint256,address,uint256,bytes)']);
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)']);
const repAbi=parseAbi(['function getSummary(uint256,address[],string,string) view returns(uint64,int128,uint8)']);
const journalPath=new URL('../contracts/cache/monad-mainnet-demo.json',import.meta.url);
const journal:any=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{chainId:143,adapter,steps:{},jobs:{},cids:{}};
if(journal.chainId!==143||journal.adapter.toLowerCase()!==adapter.toLowerCase())throw Error('Demo journal deployment mismatch');
const save=()=>writeFileSync(journalPath,JSON.stringify(journal,(_,v)=>typeof v==='bigint'?v.toString():v,2));
const read=(functionName:string,args:readonly unknown[]=[])=>pub.readContract({address:adapter,abi:BOUNTY_ADAPTER_V48_ABI,functionName:functionName as never,args:args as never}) as Promise<any>;
const tokenBalance=(address:Address)=>pub.readContract({address:poster.network.usdc,abi:tokenAbi,functionName:'balanceOf',args:[address]});
async function step(name:string,fn:()=>Promise<any>){
  if(journal.steps[name]){console.log(`${name}: already confirmed`);return journal.steps[name];}
  const result=await fn();const receipt=result.receipt??result;
  if(receipt.status!=='success')throw Error(`${name}: failed receipt`);
  journal.steps[name]={hash:receipt.transactionHash,block:receipt.blockNumber,gasUsed:receipt.gasUsed,...(result.jobId!==undefined?{jobId:result.jobId}:{})};save();console.log(`${name}: ${receipt.transactionHash}`);return journal.steps[name];
}
async function direct(signer:ViemSigner,address:Address,abi:readonly unknown[],functionName:string,args:readonly unknown[]){
  const estimated=await pub.estimateContractGas({account:signer.address,address,abi:abi as never,functionName,args:args as never});
  const gas=estimated+(estimated+1n)/2n;
  if(gas*await pub.getGasPrice()>300_000_000_000_000_000n)throw Error('Per-action gas budget exceeds 0.3 MON');
  const hash=await signer.writeContract({address,abi,functionName,args,gas});const receipt=await pub.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error('Transaction reverted');return receipt;
}
async function pin(name:string,content:string){if(journal.cids[name])return journal.cids[name];const cid=await pinText(content);journal.cids[name]=cid;save();return cid;}
class Stop extends Error{}
let keys:Awaited<ReturnType<typeof deriveContestKeypair>>;
async function create(name:string,contest:boolean,reward=1_000_000n,maxEntries=1,bond=false){
  if(journal.jobs[name])return BigInt(journal.jobs[name]);
  const cid=await pin(`description-${name}`,JSON.stringify({name:`NadBounty mainnet demo: ${name}`,description:'Launch demonstration on Monad mainnet with real USDC.',...(contest?{contestPublicKey:keys.publicKey}:{})}));
  const p:NadBountyCreateParams={provider:ownerAccount.address,reward,deadline:(await pub.getBlock()).timestamp+172800n,ipfsDescHash:cid,category:'dev',tags:['mainnet-demo'],agentOnly:true,humanOnly:false,requireWorkerBond:bond,contest,maxEntries:contest?maxEntries:0,winners:contest?1:0,minJobs:0n,minAvgScore:0};
  const result=await step(`${name}-create`,()=>poster.createBounty(p));journal.jobs[name]=result.jobId;save();return BigInt(result.jobId);
}
try{
  if(await pub.getChainId()!==143||deployment.chainId!==143)throw Error('Mainnet only');
  console.log(`MAINNET: deployer ${formatEther(await pub.getBalance({address:posterAccount.address}))} MON, ${formatUnits(await tokenBalance(posterAccount.address),6)} USDC`);
  if(!process.argv.includes('--broadcast')){throw new Stop('Review only. With --broadcast: demo identity + working wallet, 3 scenarios (1 USDC single with bond, 2 USDC encrypted contest, 1 USDC contest cancelled). About 4 USDC moves, about 3.97 USDC returns to the demo owner/poster, 0.03 USDC fees go to the Safe. Gas top-ups: demo owner 0.5 MON, demo worker 1.5 MON, mainnet keeper 2 MON, reputation relayer 1 MON.');}
  if(journal.complete)throw new Stop('Demo already complete.');
  if((await read('owner')).toLowerCase()!==posterAccount.address.toLowerCase()||(await read('arbitrator')).toLowerCase()!==posterAccount.address.toLowerCase())throw Error('Run the demo before the Safe handoff');
  if(await tokenBalance(posterAccount.address)<5_000_000n&&!journal.steps['single-create'])throw Error('At least 5 USDC required on the deployer');
  if(await pub.getBalance({address:posterAccount.address})<13_000_000_000_000_000_000n)throw Error('Need gas budget plus 10 MON reserve');
  for(const[address,target]of [[ownerAccount.address,500_000_000_000_000_000n],[workingAccount.address,1_500_000_000_000_000_000n],[keeperAddress,2_000_000_000_000_000_000n],[relayerAddress,1_000_000_000_000_000_000n]] as const){
    const current=await pub.getBalance({address});if(current<target)await step(`gas-${address}`,async()=>{const gas=31500n;const hash=await wallet.sendTransaction({to:address,value:target-current,gas});return pub.waitForTransactionReceipt({hash});});
  }
  if(!journal.agentId){
    const receipt=await step('register-identity',()=>direct(ownerSigner,poster.network.identity,idAbi,'register',[]));
    const actual=await pub.getTransactionReceipt({hash:receipt.hash});
    const transfer=actual.logs.find(l=>l.address.toLowerCase()===poster.network.identity.toLowerCase()&&l.topics[0]==='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'&&l.topics.length===4);
    if(!transfer)throw Error('Identity mint event missing');journal.agentId=BigInt(transfer.topics[3]!).toString();save();
  }
  const agentId=BigInt(journal.agentId);
  if((await pub.readContract({address:poster.network.identity,abi:idAbi,functionName:'ownerOf',args:[agentId]})).toLowerCase()!==ownerAccount.address.toLowerCase())throw Error('Wrong identity owner');
  await step('set-working-wallet',async()=>{
    const deadline=(await pub.getBlock()).timestamp+300n;
    const signature=await workingAccount.signTypedData({domain:{name:'ERC8004IdentityRegistry',version:'1',chainId:143,verifyingContract:poster.network.identity},types:{AgentWalletSet:[{name:'agentId',type:'uint256'},{name:'newWallet',type:'address'},{name:'owner',type:'address'},{name:'deadline',type:'uint256'}]},primaryType:'AgentWalletSet',message:{agentId,newWallet:workingAccount.address,owner:ownerAccount.address,deadline}});
    return direct(ownerSigner,poster.network.identity,idAbi,'setAgentWallet',[agentId,workingAccount.address,deadline,signature]);
  });
  if((await pub.readContract({address:poster.network.identity,abi:idAbi,functionName:'getAgentWallet',args:[agentId]})).toLowerCase()!==workingAccount.address.toLowerCase())throw Error('Working wallet readback failed');
  await step('fund-working-bond',()=>direct(posterSigner,poster.network.usdc,tokenAbi,'transfer',[workingAccount.address,1_000_000n]));
  if(!journal.before){journal.before={ownerUSDC:await tokenBalance(ownerAccount.address),workingUSDC:await tokenBalance(workingAccount.address),safeUSDC:await tokenBalance(deployment.safe)};save();}
  const signature=await posterAccount.signMessage({message:`NadBounty mainnet demo encryption v1:${adapter}`});
  keys=await deriveContestKeypair(new Uint8Array(Buffer.from(signature.slice(2),'hex')),`143:${adapter}`);
  const plain='NadBounty mainnet demo: an encrypted contest entry only the poster can read.';
  const envelope=await encryptContestEntry(plain,keys.publicKey);if(await decryptContestEntry(envelope,keys)!==plain)throw Error('Encryption roundtrip failed');
  const resultCid=await pin('encrypted-entry',JSON.stringify(envelope));
  const replacementCid=await pin('encrypted-replacement',JSON.stringify(await encryptContestEntry(plain+' Replacement.',keys.publicKey)));
  const workCid=await pin('single-work','NadBounty mainnet demo: delivered work for the single-taker bounty.');
  await step('unpause',()=>direct(posterSigner,adapter,BOUNTY_ADAPTER_V48_ABI,'setPaused',[false]));
  const single=await create('single',false,1_000_000n,1,true);
  await step('single-take',()=>worker.takeBounty(single,agentId));await step('single-submit',()=>worker.submitWork(single,workCid));await step('single-approve',()=>poster.approveBounty(single,90));
  const early=await create('contest-early',true,2_000_000n,2);
  await step('contest-enter',()=>worker.enterContest(early,agentId,resultCid));await step('contest-replace',()=>worker.replaceContestEntry(early,0,replacementCid));await step('contest-pick',()=>poster.pickContestWinners(early,[0],[90]));
  const cancel=await create('contest-cancel',true);await step('contest-cancel-refund',()=>poster.cancelBounty(cancel));
  for(const[name,id]of Object.entries(journal.jobs)){if(!(await poster.getBounty(BigInt(id as string))).resolved)throw Error(`${name}: not resolved`);}
  const summary=await pub.readContract({address:poster.network.reputation,abi:repAbi,functionName:'getSummary',args:[agentId,[adapter],'bounty_completed','']});
  const ownerPaid=(await tokenBalance(ownerAccount.address))-BigInt(journal.before.ownerUSDC);
  const fees=(await tokenBalance(deployment.safe))-BigInt(journal.before.safeUSDC);
  if(ownerPaid!==2_970_000n||fees!==30_000n||summary[0]!==2n||summary[1]!==90n||summary[2]!==0)throw Error(`Settlement verification mismatch: paid ${ownerPaid}, fees ${fees}, summary ${summary}`);
  if(await tokenBalance(workingAccount.address)!==BigInt(journal.before.workingUSDC))throw Error('Working wallet bond not returned or reward misdirected');
  journal.result={ownerPaidUSDC:formatUnits(ownerPaid,6),feesUSDC:formatUnits(fees,6),feedbackCount:summary[0],feedbackScore:summary[1],workingReceivedRewards:false};journal.complete=true;save();console.log(JSON.stringify(journal.result,(_,v)=>typeof v==='bigint'?v.toString():v));
}catch(error){if(error instanceof Stop)console.log(error.message);else console.error(String((error as any).shortMessage??(error as Error).message).replaceAll(rpc,'[RPC]'));if(!(error instanceof Stop))process.exitCode=1;}
finally{
  if(process.argv.includes('--broadcast')&&(await read('owner')).toLowerCase()===posterAccount.address.toLowerCase()&&!await read('paused')){
    const receipt=await direct(posterSigner,adapter,BOUNTY_ADAPTER_V48_ABI,'setPaused',[true]);journal.lastPause={hash:receipt.transactionHash,block:receipt.blockNumber};save();console.log(`Adapter paused: ${receipt.transactionHash}`);
  }
}
