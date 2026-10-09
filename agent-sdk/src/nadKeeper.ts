/** Pure scheduler policy. The adapter still enforces every deadline and authorization. */
export type NadKeeperMeta = {
  jobId: bigint; deadline: bigint; resolved: boolean; contest: boolean; isTaken: boolean;
  submittedResultHash: string; submittedAt: bigint; rejectedAt: bigint;
  inDispute: boolean; disputeRaisedAt: bigint; disputeResponseHash: string;
};
export type NadKeeperContest = {
  closedAt: bigint; entryCount: number;
  challenges: readonly { challengedAt: bigint; respondedAt: bigint }[];
};
export const NAD_SETTLEMENTS = [
  'autoApprove','expireBounty','finalizeRejection','claimDefaultRuling','claimArbitratorTimeout',
  'reconcileExpiredEscrow','settleContestSilence','finalizeContestRejection','claimContestDefault','claimContestArbitratorTimeout',
] as const;
export type NadSettlement = typeof NAD_SETTLEMENTS[number];
const DAY=86400n;
export function selectNadSettlement(meta:NadKeeperMeta,now:bigint,contest?:NadKeeperContest,escrowExpired=false):NadSettlement|null{
  if(meta.resolved)return null;
  if(escrowExpired)return 'reconcileExpiredEscrow';
  if(meta.contest){
    if(!contest)throw new Error('Contest state and individual challenges are required');
    if(!contest.entryCount)return now>meta.deadline?'expireBounty':null;
    if(!meta.rejectedAt)return contest.closedAt!==0n&&now>contest.closedAt+14n*DAY?'settleContestSilence':null;
    const challenges=contest.challenges.filter(c=>c.challengedAt!==0n);
    if(!challenges.length)return now>meta.rejectedAt+2n*DAY?'finalizeContestRejection':null;
    if(now>meta.rejectedAt+2n*DAY&&challenges.some(c=>!c.respondedAt&&now>c.challengedAt+2n*DAY))return 'claimContestDefault';
    if(challenges.every(c=>c.respondedAt!==0n)&&now>meta.disputeRaisedAt+30n*DAY)return 'claimContestArbitratorTimeout';
    return null;
  }
  if(meta.inDispute){
    if(!meta.disputeResponseHash&&now>meta.disputeRaisedAt+2n*DAY)return 'claimDefaultRuling';
    if(meta.disputeResponseHash&&now>meta.disputeRaisedAt+30n*DAY)return 'claimArbitratorTimeout';
    return null;
  }
  if(meta.rejectedAt)return now>meta.rejectedAt+2n*DAY?'finalizeRejection':null;
  if(meta.submittedResultHash)return now>meta.submittedAt+14n*DAY?'autoApprove':null;
  return now>meta.deadline?'expireBounty':null;
}
