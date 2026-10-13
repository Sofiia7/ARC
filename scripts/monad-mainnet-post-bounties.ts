/** Posts two genuine OPEN single-taker bounties (1 USDC each) on Monad MAINNET from the deployer wallet, so the board is not empty.
 *  Moves real funds (2 USDC are locked in escrow), so it needs --broadcast and is run by the wallet owner.
 *  Without --broadcast it only prints the plan. Safe to re-run: jobs already posted are skipped (journal). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, http, formatEther, formatUnits, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NadBountyAgent, type NadBountyCreateParams } from '../agent-sdk/src/NadBountyAgent.js';
import { pinText } from '../agent-sdk/src/ipfs.js';

const parse = (path: URL) => Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
  .filter(s => s.includes('=') && !s.trim().startsWith('#')).map(s => { const i=s.indexOf('=');return [s.slice(0,i).trim(),s.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const env = parse(new URL('../.env', import.meta.url));
for (const name of ['PINATA_JWT','PINATA_API_KEY','PINATA_SECRET']) if(env[name]) process.env[name]=env[name];
const rpc = process.env.MONAD_MAINNET_RPC_URL ?? 'https://rpc.monad.xyz';
const chain = defineChain({id:143,name:'Monad',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const pub = createPublicClient({chain,transport:http(rpc,{timeout:30000,retryCount:2})});
const deployment = JSON.parse(readFileSync(new URL('../contracts/cache/monad-mainnet-deployment.json', import.meta.url), 'utf8'));
const adapter = deployment.adapter as Address;
const key = env.BASE_MAINNET_DEPLOYER_KEY as Hex;
const account = privateKeyToAccount(key);
if (account.address.toLowerCase() !== '0x6abc2b575ec66701c17dad96dda97f22b837849e') throw Error('Unexpected poster wallet');
const poster = new NadBountyAgent({network:'monad-mainnet',privateKey:key,bountyAdapterAddress:adapter,rpcUrl:rpc});
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)']);
const journalPath = new URL('../contracts/cache/monad-mainnet-board.json', import.meta.url);
const journal: any = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {chainId:143,adapter,jobs:{}};
const save = () => writeFileSync(journalPath, JSON.stringify(journal, null, 2));
class Stop extends Error {}

const tasks = [
  { key: 'docs-review', category: 'content', title: 'Find the 3 most confusing sentences in the NadBounty developer docs',
    description: 'Read https://nadbounty.app/developers and the section "NadBounty on Monad" in https://github.com/Sofiia7/ARC. Reply in plain text, under 300 words: the 3 most confusing sentences, why each is unclear, and a clearer rewrite of each. One answer per taker; the first complete answer is paid.' },
  { key: 'mobile-bugs', category: 'dev', title: 'Report 3 real usability problems of nadbounty.app on a phone',
    description: 'Open https://nadbounty.app on a phone (any browser). Reply in plain text, under 300 words: 3 concrete usability problems, each with the steps to reproduce it, the device and the browser. One answer per taker; the first complete answer is paid.' },
];
const reward = 1_000_000n, days = 14n;

try {
  if (await pub.getChainId() !== 143) throw Error('Mainnet only');
  const usdc = poster.network.usdc;
  const usdcBalance = await pub.readContract({address:usdc,abi:tokenAbi,functionName:'balanceOf',args:[account.address]});
  console.log(`MAINNET poster ${formatEther(await pub.getBalance({address:account.address}))} MON, ${formatUnits(usdcBalance,6)} USDC`);
  if (!process.argv.includes('--broadcast')) throw new Stop(`Plan: ${tasks.length} open single-taker bounties of 1 USDC each, ${days} days, no worker bond. ${tasks.length} USDC locked in escrow; 1% fee only on payout. Add --broadcast to post.`);
  if (usdcBalance < BigInt(tasks.length) * reward) throw Error('Not enough USDC on the poster wallet');
  if (await pub.readContract({address:adapter,abi:parseAbi(['function paused() view returns(bool)']),functionName:'paused'})) throw Error('Adapter is paused');
  for (const t of tasks) {
    if (journal.jobs[t.key]) { console.log(`${t.key}: already posted as job ${journal.jobs[t.key].jobId}`); continue; }
    const cid = await pinText(JSON.stringify({version:1,title:t.title,description:t.description}));
    const p: NadBountyCreateParams = {provider:'0x0000000000000000000000000000000000000000',reward,deadline:(await pub.getBlock()).timestamp+days*86400n,ipfsDescHash:cid,category:t.category,tags:[],agentOnly:false,humanOnly:false,requireWorkerBond:false,contest:false,maxEntries:0,winners:0,minJobs:0n,minAvgScore:0};
    const result: any = await poster.createBounty(p);
    const receipt = result.receipt ?? result;
    if (receipt.status !== 'success') throw Error(`${t.key}: transaction failed`);
    journal.jobs[t.key] = {jobId: String(result.jobId), hash: receipt.transactionHash, cid}; save();
    console.log(`${t.key}: job ${journal.jobs[t.key].jobId} ${receipt.transactionHash}`);
  }
  console.log('Done. Open https://nadbounty.app to see the board.');
} catch (error) {
  if (error instanceof Stop) console.log(error.message);
  else { console.error(String((error as any).shortMessage ?? (error as Error).message).replaceAll(rpc, '[RPC]')); process.exitCode = 1; }
}
