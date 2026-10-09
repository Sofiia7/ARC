import {NextRequest,NextResponse} from 'next/server';
import {timingSafeEqual} from 'node:crypto';
import {runNadReminders} from '@/lib/nadReminderRunner';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(req:NextRequest){
  const secret=process.env.CRON_SECRET;
  const a=Buffer.from(req.headers.get('authorization')??''),b=Buffer.from(`Bearer ${secret??''}`);
  if(!secret||a.length!==b.length||!timingSafeEqual(a,b))return NextResponse.json({error:'unauthorized'},{status:401});
  try{return NextResponse.json(await runNadReminders(req.nextUrl.searchParams.get('dryRun')!=='1'));}
  catch(e){console.error('Nad reminder run failed',{errorType:e instanceof Error?e.name:'unknown'});return NextResponse.json({error:'Reminder run failed; credentials and chat IDs omitted'},{status:503});}
}
