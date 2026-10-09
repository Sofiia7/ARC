import {encodeAbiParameters,zeroAddress,type Address} from 'viem';
export type Feedback = {agentId: bigint; client: Address; index: bigint; value: bigint; decimals: number; tag: string; tag2: string; revoked: boolean};
export type OwnerRecord = {identityOwner: Address; sourceChain: number; sourceBlock: bigint; paidJobs: bigint; scoreSum: bigint};
/** Skip unchanged values while retaining the block of the last delivered exact snapshot. */
export function needsMirrorUpdate(record: OwnerRecord, actual: readonly [bigint,bigint,bigint,bigint]) {
  if(actual[2]>record.sourceBlock)throw Error('Mirror is ahead of the finalized source; retry later');
  if(actual[2]===record.sourceBlock&&(actual[0]!==record.paidJobs||actual[1]!==record.scoreSum))throw Error('Conflicting same-block mirror record');
  return actual[2]===0n||actual[0]!==record.paidJobs||actual[1]!==record.scoreSum;
}
export const mirrorReportParameters=[{type:'tuple[]',components:[{name:'identityOwner',type:'address'},{name:'sourceChain',type:'uint256'},{name:'sourceBlock',type:'uint64'},{name:'paidJobs',type:'uint64'},{name:'scoreSum',type:'uint128'}]}] as const;
/** Payload for ReputationMirror.onReport, not a DON attestation. */
export function encodeMirrorReport(records: OwnerRecord[]) {
  if(!records.length||records.length>100) throw Error('Mirror batch must contain 1..100 records');
  const seen=new Set<string>();
  for(const r of records){
    if(![8453,5042].includes(r.sourceChain)||r.sourceBlock<1n||r.sourceBlock>=2n**64n||r.paidJobs<0n||r.paidJobs>=2n**64n||r.scoreSum<0n||r.scoreSum>100n*r.paidJobs||r.scoreSum>=2n**128n||r.identityOwner.toLowerCase()===zeroAddress)throw Error('Invalid mirror record');
    const key=`${r.sourceChain}:${r.identityOwner.toLowerCase()}`;
    if(seen.has(key)) throw Error('Duplicate owner/source record'); seen.add(key);
  }
  return encodeAbiParameters(mirrorReportParameters,[records.map(r=>({...r,sourceChain:BigInt(r.sourceChain)}))]);
}
const paidTags = new Set(['bounty_completed', 'bounty_auto_approved']);
/** Current identity ownership at the SAME source block determines attribution.
 * Previous recipients must be supplied so transfers/revocations can clear mirrors.
 * Never reconstruct scoreSum from an integer average. */
export function aggregateReputation(sourceChain: number, sourceBlock: bigint, clients: readonly Address[], owners: ReadonlyMap<bigint, Address>, feedback: Feedback[], previousOwners: Address[] = []): OwnerRecord[] {
  if (![8453,5042].includes(sourceChain) || sourceBlock < 1n) throw Error('Invalid reputation source');
  const allowed = new Set(clients.map(c=>c.toLowerCase()));
  if (!allowed.size || allowed.has(zeroAddress)) throw Error('Explicit feedback writers required');
  const result = new Map<string,OwnerRecord>();
  const ensure = (owner: Address) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || owner.toLowerCase()===zeroAddress) throw Error('Invalid identity owner');
    const key=owner.toLowerCase();
    if (!result.has(key)) result.set(key,{identityOwner:key as Address,sourceChain,sourceBlock,paidJobs:0n,scoreSum:0n});
    return result.get(key)!;
  };
  previousOwners.forEach(ensure); owners.forEach(ensure);
  const seen=new Map<string,string>();
  for (const f of feedback) {
    if (!allowed.has(f.client.toLowerCase())) throw Error('Unexpected feedback writer');
    if (f.index<1n) throw Error('Invalid feedback index');
    const id=`${f.agentId}:${f.client.toLowerCase()}:${f.index}`;
    const fingerprint=JSON.stringify([String(f.value),f.decimals,f.tag,f.tag2,f.revoked]);
    if (seen.has(id)) { if(seen.get(id)!==fingerprint) throw Error('Conflicting feedback'); continue; }
    seen.set(id,fingerprint);
    if (f.revoked || !paidTags.has(f.tag)) continue;
    if (f.decimals!==0 || f.value<0n || f.value>100n || f.tag2!=='') throw Error('Unexpected paid score format');
    const owner=owners.get(f.agentId); if(!owner) throw Error('Missing identity provenance');
    const record=ensure(owner); record.paidJobs++; record.scoreSum+=f.value;
  }
  return [...result.values()].sort((a,b)=>a.identityOwner.localeCompare(b.identityOwner));
}

