export type ContestPaymentMethod='pickContestWinners'|'acceptContestChallengers';
type State={resolved:boolean;contest:boolean;inDispute:boolean;rejectedAt:bigint};
export function contestPaymentMethod(meta:State,closedAt:bigint,now:bigint):ContestPaymentMethod|null{
 if(meta.resolved||!meta.contest)return null;
 if(meta.inDispute)return 'acceptContestChallengers';
 if(meta.rejectedAt!==0n||closedAt!==0n&&now>closedAt+1209600n)return null;
 return 'pickContestWinners';
}
export function validateContestPayment(indices:number[],scores:number[],entryCount:number,winners:number,method:ContestPaymentMethod,challenges:readonly{challengedAt:bigint}[]){
 if(indices.length<1||indices.length>winners)throw Error(`Select between 1 and ${winners} winners.`);
 if(scores.length!==indices.length||new Set(indices).size!==indices.length)throw Error('Each winner must be selected once with one score.');
 for(let i=0;i<indices.length;i++){
  const index=indices[i];
  if(!Number.isInteger(index)||index<0||index>=entryCount)throw Error('Selected entry no longer exists. Reload the contest.');
  if(!Number.isInteger(scores[i])||scores[i]<0||scores[i]>100)throw Error('Scores must be whole numbers from 0 to 100.');
  if(method==='acceptContestChallengers'&&!(challenges[index]?.challengedAt>0n))throw Error('Select only entries that challenged the rejection.');
 }
}
