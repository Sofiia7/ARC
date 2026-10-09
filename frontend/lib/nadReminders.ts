export type Reminder={key:string;text:string};
type ReminderState={jobId:bigint;resolved:boolean;contest:boolean;submittedAt:bigint;rejectedAt:bigint;closedAt:bigint;entries:readonly{resultHash:string}[];challenges:readonly{challengedAt:bigint;respondedAt:bigint}[];inDispute:boolean;disputeRaisedAt:bigint;disputeResponseHash:string};
const DAY=86400n;
/** Exact per-challenge deadlines; reminders never change the contract clock. */
export function planNadReminders(state:ReminderState,now:bigint):Reminder[]{
  if(state.resolved)return[];
  const result:Reminder[]=[],job=String(state.jobId);
  if(state.contest)state.entries.forEach((e,i)=>result.push({key:`entry:${i}:${e.resultHash}`,text:`Contest #${job}: entry ${i+1} is available for review.`}));
  const start=state.contest?state.closedAt:state.submittedAt;
  if(start&&!state.rejectedAt&&!state.inDispute){
    const deadline=start+14n*DAY,remaining=deadline-now;
    if(remaining>0n&&remaining<=7n*DAY){
      const days=remaining<=2n*DAY?2:7;
      result.push({key:`review:${deadline}:${days}`,text:`Bounty #${job}: ${days===2?'less than 2 days':'less than 7 days'} remain to review. Review ends ${new Date(Number(deadline)*1000).toISOString()}. Silence can release escrow automatically.`});
    }
  }
  const challenges=state.contest?state.challenges:state.inDispute?[{challengedAt:state.disputeRaisedAt,respondedAt:state.disputeResponseHash?1n:0n}]:[];
  challenges.forEach((c,i)=>{
    if(!c.challengedAt||c.respondedAt)return;
    const deadline=c.challengedAt+2n*DAY,remaining=deadline-now;
    if(remaining<=0n)return;
    const urgent=remaining<=12n*3600n;
    result.push({key:`challenge:${i}:${c.challengedAt}:${urgent?'12h':'new'}`,text:`Bounty #${job}${state.contest?`, entry ${i+1}`:''}: ${urgent?'less than 12 hours remain to respond':'a challenge needs your response'}. Deadline ${new Date(Number(deadline)*1000).toISOString()}. An unanswered challenge can receive a default ruling.`});
  });
  return result;
}
