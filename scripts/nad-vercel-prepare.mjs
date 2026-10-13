/** Isolated testnet upload tree. Never copies root keys, local env or existing Arc project linkage. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'..'),source=path.join(root,'frontend'),mainnet=process.argv.includes('--mainnet'),target=path.join(os.tmpdir(),mainnet?'nadbounty-mainnet-deploy':'nadbounty-testnet-deploy');
await fs.mkdir(target,{recursive:true});
await fs.cp(source,target,{recursive:true,filter:entry=>{
 const name=path.basename(entry);
 return !['node_modules','.next','.vercel','tsconfig.tsbuildinfo'].includes(name)&&!name.startsWith('.env');
}});
await fs.writeFile(path.join(target,'vercel.json'),JSON.stringify({$schema:'https://openapi.vercel.sh/vercel.json',framework:'nextjs'},null,2));
await fs.writeFile(path.join(target,'.vercelignore'),'node_modules\n.next\n.env*\n.vercel\ntest\n*.tsbuildinfo\n');
console.log(`Prepared isolated NadBounty ${mainnet?'mainnet':'testnet'} upload tree; no local credentials or Arc linkage copied.`);
