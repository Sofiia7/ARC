import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestIndexer} from 'envio';
const owner='0x1111111111111111111111111111111111111111',next='0x2222222222222222222222222222222222222222';
const mirror='0x59e970574D9aDc30892d094C893DA4B73EBE40a0',hash=`0x${'ab'.repeat(32)}`;
test('same identity ID on Base and Monad stays separate; transfer updates current ownership',async()=>{
  const indexer=createTestIndexer();
  await indexer.process({chains:{
    10143:{startBlock:70000000,endBlock:70000001,simulate:[{contract:'Identity',event:'Transfer',block:{number:70000000},transaction:{hash},params:{from:owner,to:next,tokenId:7n}}]},
    8453:{startBlock:53000000,endBlock:53000001,simulate:[{contract:'Identity',event:'Transfer',block:{number:53000000},transaction:{hash},params:{from:next,to:owner,tokenId:7n}}]},
  }});
  assert.equal((await indexer.Identity.getOrThrow('10143:7')).owner,next);
  assert.equal((await indexer.Identity.getOrThrow('8453:7')).owner,owner);
  assert.equal((await indexer.IdentityTransfer.getAll()).length,2);
});
test('mirror invalidation clears one source while retaining the other',async()=>{
  const indexer=createTestIndexer(),at=70000000;
  await indexer.process({chains:{10143:{startBlock:at,endBlock:at+2,simulate:[
    {contract:'Mirror',event:'ReputationUpdated',block:{number:at},logIndex:0,params:{identityOwner:owner,sourceChain:8453n,sourceBlock:53000000n,paidJobs:2n,scoreSum:181n}},
    {contract:'Mirror',event:'ReputationUpdated',block:{number:at},logIndex:1,params:{identityOwner:owner,sourceChain:5042n,sourceBlock:25000000n,paidJobs:6n,scoreSum:535n}},
    {contract:'Mirror',event:'RecordInvalidated',block:{number:at+1},params:{identityOwner:owner,sourceChain:8453n,previousSourceBlock:53000000n}},
  ]}}});
  const base=await indexer.MirrorRecord.getOrThrow(`10143:${mirror.toLowerCase()}:${owner}:8453`);
  const arc=await indexer.MirrorRecord.getOrThrow(`10143:${mirror.toLowerCase()}:${owner}:5042`);
  assert.equal(base.valid,false);assert.equal(base.paidJobs,0n);assert.equal(base.sourceBlock,0n);
  assert.equal(arc.valid,true);assert.equal(arc.scoreSum,535n);
});
test('two events in one transaction retain distinct provenance and exact bigint payloads',async()=>{
  const indexer=createTestIndexer(),at=70000000;
  await indexer.process({chains:{10143:{startBlock:at,endBlock:at+1,simulate:[
    {contract:'Nad',event:'ContestAwarded',block:{number:at,timestamp:1800000000},transaction:{hash},logIndex:2,params:{jobId:10n,entryIndex:0,amount:9007199254740993n,scored:true,score:91}},
    {contract:'Nad',event:'ContestSettled',block:{number:at,timestamp:1800000000},transaction:{hash},logIndex:3,params:{jobId:10n,scored:true,escrowRecovery:false}},
  ]}}});
  const events=await indexer.BountyEvent.getAll();assert.equal(events.length,2);
  const award=await indexer.BountyEvent.getOrThrow(`10143:${hash}:2`);
  assert.equal(JSON.parse(award.payload).amount,'9007199254740993');
  assert.equal(award.blockNumber,at);assert.equal(award.transactionHash,hash);
});
