/** Configure the isolated NadBounty MAINNET Vercel project (project "nadbounty").
 *  Run `node scripts/nad-vercel-prepare.mjs --mainnet` and `vercel link --yes --project nadbounty` in that tree first.
 *  Values go to the Vercel CLI through stdin only: never argv, never logs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),cwd=path.join(os.tmpdir(),'nadbounty-mainnet-deploy');
const link=JSON.parse(await fs.readFile(path.join(cwd,'.vercel/project.json'),'utf8'));
if(link.projectName!=='nadbounty')throw Error('Mainnet tree is not linked to the nadbounty project');
const parse=s=>Object.fromEntries(s.split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const servicesFile=path.join(root,'.env.nad-services');
const local=parse(await fs.readFile(servicesFile,'utf8'));
if(!local.NAD_MAINNET_CRON_SECRET){local.NAD_MAINNET_CRON_SECRET=randomBytes(32).toString('hex');await fs.writeFile(servicesFile,Object.entries(local).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');}
const pinata=parse(await fs.readFile(path.join(root,'.env'),'utf8'));
const variables={
 NEXT_PUBLIC_ARC_NETWORK:'monad-mainnet',
 NAD_PUBLIC_SITE_URL:'https://nadbounty.app',
 NAD_TELEGRAM_BOT_TOKEN:local.NAD_TELEGRAM_BOT_TOKEN,
 NAD_TELEGRAM_BOT_USERNAME:local.NAD_TELEGRAM_BOT_USERNAME,
 NAD_TELEGRAM_WEBHOOK_SECRET:local.NAD_TELEGRAM_WEBHOOK_SECRET,
 NAD_UPSTASH_REDIS_REST_URL:local.NAD_UPSTASH_REDIS_REST_URL,
 NAD_UPSTASH_REDIS_REST_TOKEN:local.NAD_UPSTASH_REDIS_REST_TOKEN,
 UPSTASH_REDIS_REST_URL:local.NAD_UPSTASH_REDIS_REST_URL,
 UPSTASH_REDIS_REST_TOKEN:local.NAD_UPSTASH_REDIS_REST_TOKEN,
 CRON_SECRET:local.NAD_MAINNET_CRON_SECRET,
 PINATA_JWT:pinata.PINATA_JWT,
 NAD_RPC_URL:'https://rpc1.monad.xyz',
};
const plain=name=>name!=='NAD_RPC_URL'&&(name.startsWith('NEXT_PUBLIC_')||name.endsWith('SITE_URL')||name.endsWith('USERNAME')||name.endsWith('_URL'));
for(const [name,value]of Object.entries(variables)){
 if(!value)throw Error(`Missing ${name}`);
 const args=['--yes','vercel@54','env','add',name,'production','--force',...(plain(name)?[]:['--sensitive'])];
 const r=spawnSync('npx',args,{cwd,input:value,encoding:'utf8',shell:true,timeout:120000});
 if(r.status!==0)throw Error(`Vercel env add failed for ${name} (exit ${r.status}); output withheld to protect credentials`);
 console.log(`Configured ${name}`);
}
const list=spawnSync('npx',['--yes','vercel@54','env','ls','production'],{cwd,encoding:'utf8',shell:true,timeout:120000});
for(const name of Object.keys(variables))if(!list.stdout.includes(name))throw Error(`Missing persisted ${name}`);
console.log('nadbounty project environment keys verified.');
