import { describe,it,expect } from 'vitest';
import { selectNadSettlement, type NadKeeperMeta } from '../src/nadKeeper.js';
const day=86400n;
const base:NadKeeperMeta={jobId:1n,deadline:100n,resolved:false,contest:false,isTaken:false,submittedResultHash:'',submittedAt:0n,rejectedAt:0n,inDispute:false,disputeRaisedAt:0n,disputeResponseHash:''};
describe('Monad keeper deadline policy',()=>{
  it('never treats the exact deadline as expired and ignores resolved jobs',()=>{expect(selectNadSettlement(base,100n)).toBeNull();expect(selectNadSettlement(base,101n)).toBe('expireBounty');expect(selectNadSettlement({...base,resolved:true},1000n,undefined,true)).toBeNull();});
  it('preserves approval/rejection/dispute clocks instead of using the job deadline',()=>{
    const submitted={...base,submittedResultHash:'ipfs://result',submittedAt:10n};expect(selectNadSettlement(submitted,10n+14n*day)).toBeNull();expect(selectNadSettlement(submitted,11n+14n*day)).toBe('autoApprove');
    const rejected={...submitted,rejectedAt:20n};expect(selectNadSettlement(rejected,20n+2n*day)).toBeNull();expect(selectNadSettlement(rejected,21n+2n*day)).toBe('finalizeRejection');
    const dispute={...rejected,inDispute:true,disputeRaisedAt:30n};expect(selectNadSettlement(dispute,31n+2n*day)).toBe('claimDefaultRuling');expect(selectNadSettlement({...dispute,disputeResponseHash:'reply'},31n+2n*day)).toBeNull();expect(selectNadSettlement({...dispute,disputeResponseHash:'reply'},31n+30n*day)).toBe('claimArbitratorTimeout');
  });
  it('uses the individual late challenge deadline, not the first dispute timestamp',()=>{
    const meta={...base,contest:true,rejectedAt:100n,inDispute:true,disputeRaisedAt:110n};
    const contest={closedAt:90n,entryCount:2,challenges:[{challengedAt:110n,respondedAt:120n},{challengedAt:100n+2n*day,respondedAt:0n}]};
    expect(selectNadSettlement(meta,101n+2n*day,contest)).toBeNull();expect(selectNadSettlement(meta,100n+4n*day,contest)).toBeNull();expect(selectNadSettlement(meta,101n+4n*day,contest)).toBe('claimContestDefault');
  });
  it('separates empty, silence, no-challenge and all-responded contest paths',()=>{
    const meta={...base,contest:true};expect(selectNadSettlement(meta,101n,{closedAt:100n,entryCount:0,challenges:[]})).toBe('expireBounty');
    const contest={closedAt:90n,entryCount:1,challenges:[]};expect(selectNadSettlement(meta,90n+14n*day,contest)).toBeNull();expect(selectNadSettlement(meta,91n+14n*day,contest)).toBe('settleContestSilence');
    const rejected={...meta,rejectedAt:100n,inDispute:true,disputeRaisedAt:110n};expect(selectNadSettlement(rejected,101n+2n*day,contest)).toBe('finalizeContestRejection');
    const answered={...contest,challenges:[{challengedAt:110n,respondedAt:120n}]};expect(selectNadSettlement(rejected,111n+30n*day,answered)).toBe('claimContestArbitratorTimeout');
  });
  it('prioritizes real escrow expiry recovery, and requires contest inputs',()=>{expect(selectNadSettlement(base,1n,undefined,true)).toBe('reconcileExpiredEscrow');expect(()=>selectNadSettlement({...base,contest:true},1n)).toThrow('Contest state');});
});
