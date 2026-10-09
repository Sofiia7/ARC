import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeAbiParameters,type Address} from 'viem';
import {aggregateReputation,encodeMirrorReport,mirrorReportParameters,type Feedback} from '../src/reputation.js';
const writer='0x1111111111111111111111111111111111111111',oldOwner='0x2222222222222222222222222222222222222222',owner='0x3333333333333333333333333333333333333333';
const row=(index:bigint,value:bigint,extra:Partial<Feedback>={}):Feedback=>({agentId:7n,client:writer,index,value,decimals:0,tag:'bounty_completed',tag2:'',revoked:false,...extra});
test('exact sum survives rounded-average loss; zero-score paid work counts',()=>{
  const records=aggregateReputation(8453,10n,[writer],new Map([[7n,owner]]),[row(1n,90n),row(2n,91n),row(3n,0n)]);
  assert.equal(records[0].paidJobs,3n);assert.equal(records[0].scoreSum,181n);
});
test('revocations and penalties excluded; auto approval included',()=>{
  const records=aggregateReputation(5042,10n,[writer],new Map([[7n,owner]]),[row(1n,90n,{revoked:true}),row(2n,-20n,{tag:'dispute_penalty'}),row(3n,80n,{tag:'bounty_auto_approved'})]);
  assert.equal(records[0].paidJobs,1n);assert.equal(records[0].scoreSum,80n);
});
test('transfer moves history and emits a zero snapshot for old recipient',()=>{
  const records=aggregateReputation(8453,11n,[writer],new Map([[7n,owner],[8n,owner]]),[row(1n,90n),row(1n,80n,{agentId:8n})],[oldOwner]);
  assert.equal(records.find(r=>r.identityOwner===oldOwner)!.paidJobs,0n);
  assert.equal(records.find(r=>r.identityOwner===owner)!.scoreSum,170n);
});
test('replayed records deduplicate, conflicting replay fails closed',()=>{
  const args=[8453,10n,[writer],new Map<bigint,Address>([[7n,owner]])] as const;
  assert.equal(aggregateReputation(...args,[row(1n,90n),row(1n,90n)])[0].paidJobs,1n);
  assert.throws(()=>aggregateReputation(...args,[row(1n,90n),row(1n,91n)]),/Conflicting/);
});
test('untrusted clients, malformed paid values and missing provenance fail closed',()=>{
  const run=(f:Feedback,owners=new Map<bigint,Address>([[7n,owner]]))=>aggregateReputation(8453,10n,[writer],owners,[f]);
  for(const f of [row(1n,90n,{client:owner}),row(1n,-1n),row(1n,101n),row(1n,90n,{decimals:1}),row(0n,90n)]) assert.throws(()=>run(f));
  assert.throws(()=>run(row(1n,90n),new Map()),/provenance/);
});
test('mirror wire payload preserves exact values and rejects ambiguous/out-of-range batches',()=>{
  const records=aggregateReputation(8453,10n,[writer],new Map([[7n,owner]]),[row(1n,91n)]);
  const [decoded]=decodeAbiParameters(mirrorReportParameters,encodeMirrorReport(records));
  assert.equal(decoded[0].scoreSum,91n);assert.equal(decoded[0].sourceChain,8453n);
  assert.throws(()=>encodeMirrorReport([...records,...records]),/Duplicate/);
  assert.throws(()=>encodeMirrorReport([{...records[0],sourceBlock:2n**64n}]),/Invalid/);
  assert.throws(()=>encodeMirrorReport([]),/1..100/);
});
