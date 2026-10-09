import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planNadReminders} from '../lib/nadReminders';
const DAY=86400n,base={jobId:7n,resolved:false,contest:true,submittedAt:0n,rejectedAt:0n,closedAt:1000n,entries:[],challenges:[],inDispute:false,disputeRaisedAt:0n,disputeResponseHash:''};
test('Review reminders use 14-day review clock and avoid simultaneous 7/2-day alerts',()=>{
  const early=planNadReminders(base,1000n+6n*DAY);assert.equal(early.length,0);
  assert.match(planNadReminders(base,1000n+8n*DAY)[0].text,/7 days/);
  const late=planNadReminders(base,1000n+13n*DAY);assert.equal(late.length,1);assert.match(late[0].text,/2 days/);
  assert.equal(planNadReminders(base,1000n+14n*DAY).length,0);
});
test('Late challenges get their own 48h, and 12h reminders stop after a response',()=>{
  const challengedAt=100000n;
  const state={...base,rejectedAt:1n,inDispute:true,challenges:[{challengedAt,respondedAt:0n}]};
  assert.match(planNadReminders(state,challengedAt+1n)[0].key,/:new$/);
  assert.match(planNadReminders(state,challengedAt+36n*3600n)[0].key,/:12h$/);
  assert.equal(planNadReminders({...state,challenges:[{challengedAt,respondedAt:1n}]},challengedAt+36n*3600n).length,0);
  assert.equal(planNadReminders(state,challengedAt+48n*3600n).length,0);
});
test('Resolved jobs generate nothing; entry replacement changes dedup identity',()=>{
  assert.deepEqual(planNadReminders({...base,resolved:true,entries:[{resultHash:'cid'}]},1001n),[]);
  assert.notEqual(planNadReminders({...base,entries:[{resultHash:'old'}]},1001n)[0].key,planNadReminders({...base,entries:[{resultHash:'new'}]},1001n)[0].key);
});
test('Single-taker reminders start at submission and use its dispute response clock',()=>{
  const single={...base,contest:false,closedAt:0n,submittedAt:2000n};
  assert.equal(planNadReminders(single,2000n+13n*DAY).length,1);
  assert.match(planNadReminders({...single,inDispute:true,disputeRaisedAt:2000n},2001n)[0].key,/challenge/);
  assert.equal(planNadReminders({...single,inDispute:true,disputeRaisedAt:2000n,disputeResponseHash:'response'},2001n).length,0);
});
