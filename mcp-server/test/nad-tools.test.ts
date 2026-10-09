import {describe,it,expect,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {NadBountyAgent} from 'arcbounty-agent-sdk';
import {createNadMcpServer} from '../src/nad-tools.js';
async function connect(hasSigner=true){
  const createBounty=vi.fn(async()=>({jobId:48n,receipt:{transactionHash:'0x123',status:'success'}}));
  const pickContestWinners=vi.fn(async()=>({transactionHash:'0x456',status:'success',gasUsed:42n}));
  const agent={address:'0x1111111111111111111111111111111111111111',bountyAdapter:'0x2222222222222222222222222222222222222222',network:{chainId:10143,usdc:'0x3333333333333333333333333333333333333333'},createBounty,pickContestWinners} as unknown as NadBountyAgent;
  const server=createNadMcpServer({agent,hasSigner,version:'test',limits:{maxRewardUsdc:20,maxSpendUsdc:25}});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);const client=new Client({name:'test',version:'1'});await client.connect(a);return{client,createBounty,pickContestWinners};
}
const params={rewardUsdc:'20',deadline:'2000000000',descriptionCid:'ipfs://description',category:'dev',contest:true,maxEntries:10,winners:2};
describe('NadBounty MCP',()=>{
  it('exposes read/encryption tools without registering writes in read-only mode',async()=>{const{client}=await connect(false);const names=(await client.listTools()).tools.map(t=>t.name);expect(names).toContain('get_contest');expect(names).toContain('encrypt_contest_entry');expect(names).not.toContain('post_bounty');expect(names).not.toContain('enter_contest');const r=await client.callTool({name:'network',arguments:{}});expect(JSON.stringify(r)).toContain('MON');await client.close();});
  it('preserves exact six-decimal reward and V4.8 contest/gate fields',async()=>{const{client,createBounty}=await connect();const r=await client.callTool({name:'post_bounty',arguments:{...params,rewardUsdc:'1.000001',minJobs:'3',minAvgScore:80}});expect(r.isError).toBeFalsy();expect(createBounty).toHaveBeenCalledWith(expect.objectContaining({reward:1_000_001n,contest:true,maxEntries:10,winners:2,minJobs:3n,minAvgScore:80}));await client.close();});
  it('reserves spend capacity before concurrent creates await the RPC',async()=>{const{client,createBounty}=await connect();const result=await Promise.all([client.callTool({name:'post_bounty',arguments:params}),client.callTool({name:'post_bounty',arguments:params})]);expect(result.filter(r=>r.isError)).toHaveLength(1);expect(createBounty).toHaveBeenCalledTimes(1);await client.close();});
  it('refuses incompatible contest flags and mismatched winner scores before a transaction',async()=>{const{client,createBounty,pickContestWinners}=await connect();expect((await client.callTool({name:'post_bounty',arguments:{...params,requireWorkerBond:true}})).isError).toBe(true);expect(createBounty).not.toHaveBeenCalled();expect((await client.callTool({name:'pick_contest_winners',arguments:{jobId:'48',indices:[0,1],scores:[90]}})).isError).toBe(true);expect(pickContestWinners).not.toHaveBeenCalled();await client.close();});
});
