import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseUnits, type Address } from 'viem';
import { NadBountyAgent, encryptContestEntry, decryptContestEntry, type EncryptedContestEntry } from 'arcbounty-agent-sdk';
import { DEFAULT_SPEND_LIMITS, spendLimitError, type SpendLimits } from './limits.js';

const job = z.string().regex(/^\d+$/).describe('On-chain job id');
const cid = z.string().min(1).max(96).describe('IPFS CID; contest entries must contain sealed-box ciphertext');
const index = z.number().int().min(0).max(24);
const score = z.number().int().min(0).max(100);
const indices = z.array(index).min(1).max(25).refine(a=>new Set(a).size===a.length,'Indices must be distinct');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);

/** Independent V4.8 surface: legacy Arc/Base tools retain their V4.7 ABI. */
export function createNadMcpServer({agent,hasSigner,version,limits=DEFAULT_SPEND_LIMITS}:{agent:NadBountyAgent;hasSigner:boolean;version:string;limits?:SpendLimits}){
  const server=new McpServer({name:'nadbounty',version});
  const json=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)}]});
  const guarded=(fn:(args:any)=>Promise<unknown>)=>async(args:any)=>{try{return json(await fn(args));}catch(error){return{isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:String(error)}]};}};
  const receipt=(fn:(args:any)=>Promise<any>)=>guarded(async args=>{const r=await fn(args);return{transactionHash:r.transactionHash,status:r.status,gasUsed:r.gasUsed};});
  server.tool('network','Monad network, contract and signing configuration. Gas requires MON; rewards use 6-decimal USDC.',{},guarded(async()=>({chainId:agent.network.chainId,adapter:agent.bountyAdapter,usdc:agent.network.usdc,gasToken:'MON',hasSigner,...(hasSigner?{signer:agent.address}:{})})));
  server.tool('list_open_bounties','List open NadBounty V4.8 jobs; paginate with offset.',{category:z.string().max(16).default(''),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(20)},guarded(async a=>{const ids=await agent.getOpenBounties(a.category,BigInt(a.offset),BigInt(a.limit));return Promise.all(ids.map(id=>agent.getBounty(id)));}));
  server.tool('get_bounty','Full V4.8 job metadata.',{jobId:job},guarded(a=>agent.getBounty(BigInt(a.jobId))));
  server.tool('get_contest','Contest state, encrypted entry CIDs and challenges.',{jobId:job},guarded(async a=>{const id=BigInt(a.jobId);const entries=await agent.getContestEntries(id);return{state:await agent.getContestState(id),entries,challenges:await Promise.all(entries.map((_,i)=>agent.getContestChallenge(id,i)))};}));
  server.tool('get_identity_reputation','Paid jobs and exact score sum used by the gate; feedback averages are not used to reconstruct totals.',{agentId:job,humanWallet:address.optional()},guarded(a=>agent.getIdentityReputation(BigInt(a.agentId),(a.humanWallet??agent.address) as Address)));
  server.tool('encrypt_contest_entry','Seal plaintext to the poster public key. Pin only the returned ciphertext envelope.',{plaintext:z.string().min(1).max(1_000_000),posterPublicKey:z.string().min(40).max(64)},guarded(a=>encryptContestEntry(a.plaintext,a.posterPublicKey)));
  server.tool('decrypt_contest_entry','Decrypt locally with your private poster key. Private key is never pinned or sent to an RPC.',{entry:z.object({version:z.literal(1),algorithm:z.literal('x25519-xsalsa20-poly1305-sealedbox'),recipientPublicKey:z.string(),ciphertext:z.string().max(1_400_100)}),publicKey:z.string(),privateKey:z.string()},guarded(a=>decryptContestEntry(a.entry as EncryptedContestEntry,{publicKey:a.publicKey,privateKey:a.privateKey})));
  if(!hasSigner)return server;
  let spent=0;
  server.tool('post_bounty','Fund a single-taker job or encrypted contest. Rewards are USDC; operator spending caps apply.',{
    rewardUsdc:amount,deadline:job,descriptionCid:cid,category:z.enum(['dev','design','content','data','other']),tags:z.array(z.string().min(1).max(32)).max(10).default([]),provider:address.default('0x0000000000000000000000000000000000000000'),agentOnly:z.boolean().default(false),humanOnly:z.boolean().default(false),requireWorkerBond:z.boolean().default(false),contest:z.boolean().default(false),maxEntries:z.number().int().min(1).max(25).default(10),winners:z.number().int().min(1).max(25).default(1),minJobs:job.default('0'),minAvgScore:score.default(0),
  },guarded(async a=>{
    const reward=parseUnits(a.rewardUsdc,6);if(reward<1_000_000n)throw Error('Minimum reward is 1 USDC');
    if(a.agentOnly&&a.humanOnly)throw Error('Choose agentOnly or humanOnly');if(a.contest&&(a.requireWorkerBond||a.winners>a.maxEntries))throw Error('Invalid contest configuration');
    const error=spendLimitError(Number(a.rewardUsdc),spent,limits);if(error)throw Error(error);
    // Reserve before awaiting: simultaneous calls cannot evade the process cap.
    spent+=Number(a.rewardUsdc);
    return agent.createBounty({provider:a.provider as Address,reward,deadline:BigInt(a.deadline),ipfsDescHash:a.descriptionCid,category:a.category,tags:a.tags,agentOnly:a.agentOnly,humanOnly:a.humanOnly,requireWorkerBond:a.requireWorkerBond,contest:a.contest,maxEntries:a.contest?a.maxEntries:0,winners:a.contest?a.winners:0,minJobs:BigInt(a.minJobs),minAvgScore:a.minAvgScore});
  }));
  server.tool('take_bounty','Take using the current identity owner or working wallet; bond allowance is handled by SDK.',{jobId:job,agentId:job.default('0')},receipt(a=>agent.takeBounty(BigInt(a.jobId),BigInt(a.agentId))));
  server.tool('submit_work','Submit a single-taker result CID.',{jobId:job,resultCid:cid},receipt(a=>agent.submitWork(BigInt(a.jobId),a.resultCid)));
  server.tool('approve_bounty','Poster approves a single-taker submission and pays its current identity owner.',{jobId:job,score},receipt(a=>agent.approveBounty(BigInt(a.jobId),a.score)));
  server.tool('enter_contest','Enter once per identity with a CID containing only encrypted content.',{jobId:job,agentId:job.default('0'),encryptedCid:cid},receipt(a=>agent.enterContest(BigInt(a.jobId),BigInt(a.agentId),a.encryptedCid)));
  server.tool('replace_contest_entry','Replace your encrypted entry before closure.',{jobId:job,index,encryptedCid:cid},receipt(a=>agent.replaceContestEntry(BigInt(a.jobId),a.index,a.encryptedCid)));
  server.tool('pick_contest_winners','Poster selects distinct entry indices with corresponding scores.',{jobId:job,indices,scores:z.array(score).min(1).max(25)},receipt(a=>{if(a.indices.length!==a.scores.length)throw Error('One score per winner required');return agent.pickContestWinners(BigInt(a.jobId),a.indices,a.scores);}));
  server.tool('reject_all_contest_entries','Poster rejects all entries after closure; opens the 48-hour challenge window.',{jobId:job,reasonCid:cid},receipt(a=>agent.rejectAllContestEntries(BigInt(a.jobId),a.reasonCid)));
  server.tool('challenge_contest_rejection','Challenge your entry rejection with readable evidence CID.',{jobId:job,index,evidenceCid:cid},receipt(a=>agent.challengeContestRejection(BigInt(a.jobId),a.index,a.evidenceCid)));
  server.tool('respond_to_contest_challenges','Poster responds to currently unanswered challenges; each has its own 48-hour deadline.',{jobId:job,responseCid:cid},receipt(a=>agent.respondToContestChallenges(BigInt(a.jobId),a.responseCid)));
  server.tool('accept_contest_challengers','Poster pays selected challengers, including while a dispute is open.',{jobId:job,indices,scores:z.array(score).min(1).max(25)},receipt(a=>{if(a.indices.length!==a.scores.length)throw Error('One score per challenger required');return agent.acceptContestChallengers(BigInt(a.jobId),a.indices,a.scores);}));
  const settlements={auto_approve:'autoApprove',cancel_bounty:'cancelBounty',expire_bounty:'expireBounty',settle_contest_silence:'settleContestSilence',finalize_contest_rejection:'finalizeContestRejection',claim_contest_default:'claimContestDefault',claim_contest_arbitrator_timeout:'claimContestArbitratorTimeout',reconcile_expired_escrow:'reconcileExpiredEscrow'} as const;
  for(const[name,method]of Object.entries(settlements))server.tool(name,'Attempt the named settlement; on-chain timing and caller rules apply.',{jobId:job},receipt(a=>agent[method](BigInt(a.jobId))));
  return server;
}
