import test from 'node:test';
import assert from 'node:assert/strict';
import {contestPaymentMethod,validateContestPayment} from '../lib/nadContestActions';
const state={resolved:false,contest:true,inDispute:false,rejectedAt:0n};
test('rejected contest cannot be picked, but a challenged rejection permits acceptance',()=>{
 assert.equal(contestPaymentMethod({...state,rejectedAt:10n},5n,11n),null);
 assert.equal(contestPaymentMethod({...state,rejectedAt:10n,inDispute:true},5n,11n),'acceptContestChallengers');
 assert.equal(contestPaymentMethod({...state,resolved:true,inDispute:true},5n,11n),null);
});
test('early picking is allowed and the exact end of review remains inclusive',()=>{
 assert.equal(contestPaymentMethod(state,0n,100n),'pickContestWinners');
 assert.equal(contestPaymentMethod(state,100n,1219700n),null);
 assert.equal(contestPaymentMethod(state,100n,1209700n),'pickContestWinners');
 assert.equal(contestPaymentMethod(state,100n,1209701n),null);
});
test('invalid count, duplicates, missing entries and fractional or oversized scores stop before a wallet prompt',()=>{
 const validate=(indices:number[],scores:number[])=>validateContestPayment(indices,scores,3,2,'pickContestWinners',[]);
 assert.doesNotThrow(()=>validate([2,0],[0,100]));
 for(const [indices,scores]of [[[],[]],[[0,1,2],[90,90,90]],[[0,0],[90,90]],[[3],[90]],[[0],[90.5]],[[0],[101]],[[0],[NaN]],[[0],[]]])assert.throws(()=>validate(indices,scores));
});
test('challenger acceptance filters out unaffected entries',()=>{
 const challenges=[{challengedAt:0n},{challengedAt:10n}];
 assert.doesNotThrow(()=>validateContestPayment([1],[95],2,2,'acceptContestChallengers',challenges));
 assert.throws(()=>validateContestPayment([0],[95],2,2,'acceptContestChallengers',challenges));
});
