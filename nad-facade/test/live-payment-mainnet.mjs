// Explicit one-shot MAINNET payment: spends exactly 0.001 real USDC from the deployer to the Safe through the hosted x402 facade.
// Without --pay it only verifies the 402 requirements and spends nothing.
import fs from 'node:fs/promises';
import {x402Client,x402HTTPClient} from '@x402/core/client';
import {ExactEvmScheme} from '@x402/evm/exact/client';
import {privateKeyToAccount} from 'viem/accounts';
import {createPublicClient,http,parseAbi} from 'viem';
const env=Object.fromEntries((await fs.readFile(new URL('../../.env',import.meta.url),'utf8')).split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const key=env.BASE_MAINNET_DEPLOYER_KEY;
const account=privateKeyToAccount(key.startsWith('0x')?key:`0x${key}`);
if(account.address.toLowerCase()!=='0x6abc2b575ec66701c17dad96dda97f22b837849e')throw Error('Unexpected rehearsal payer');
const usdc='0x754704Bc059F8C67012fEd69BC8A327a5aafb603',safe='0x74678c072Ca546f11466CD44eB7e21730a312a54';
const rpc=createPublicClient({transport:http('https://rpc.monad.xyz',{timeout:15000})});
if(await rpc.getChainId()!==143)throw Error('Wrong network');
const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
const balance=address=>rpc.readContract({address:usdc,abi:tokenAbi,functionName:'balanceOf',args:[address]});
const before=await balance(safe),payerBefore=await balance(account.address);
const hosted=!process.argv.includes('--local');
const url=hosted?'https://nadbounty-facade.vercel.app/v1/bounties/1':'http://127.0.0.1:3402/v1/bounties/1';
const unpaid=await fetch(url,{signal:AbortSignal.timeout(60000)});
if(unpaid.status!==402)throw Error('Expected initial 402');
const client=new x402HTTPClient(new x402Client().register('eip155:143',new ExactEvmScheme(account)));
const required=client.getPaymentRequiredResponse(name=>unpaid.headers.get(name));
if(required.x402Version!==2||required.accepts.length!==1)throw Error('Unexpected payment version/options');
const r=required.accepts[0];
if(r.scheme!=='exact'||r.network!=='eip155:143'||r.amount!=='1000'||r.asset.toLowerCase()!==usdc.toLowerCase()||r.payTo.toLowerCase()!==safe.toLowerCase()||r.extra?.name!=='USDC'||r.extra?.version!=='2')throw Error('Payment exceeds reviewed mainnet scope');
if(!process.argv.includes('--pay')){console.log('Mainnet 402 requirements verified; use --pay for one real 0.001 USDC payment');process.exit(0);}
const payload=await client.createPaymentPayload(required);
const paid=await fetch(url,{headers:client.encodePaymentSignatureHeader(payload),signal:AbortSignal.timeout(90000)});
if(paid.status!==200)throw Error(`Payment request failed with HTTP ${paid.status}`);
const data=await paid.json();
const settle=client.getPaymentSettleResponse(name=>paid.headers.get(name));
if(!settle.success||settle.network!=='eip155:143'||data.chainId!==143||data.meta.jobId!=='1')throw Error('Invalid settlement/snapshot');
const after=await balance(safe),payerAfter=await balance(account.address);
if(after-before!==1000n||payerBefore-payerAfter!==1000n)throw Error('Unexpected USDC balance delta');
const evidence={chainId:143,amountUSDC:'0.001',treasury:safe,payer:account.address,transaction:settle.transaction,sourceBlock:data.sourceBlock,jobId:data.meta.jobId,success:true,url};
await fs.writeFile(new URL('../../contracts/cache/nad-x402-mainnet-payment.json',import.meta.url),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
