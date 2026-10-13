/** Local signing helper for the Monad MAINNET Safe: collects and verifies owner signatures, sends no transactions. */
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {encodeFunctionData,parseAbi} from 'viem';
import {recoverSafeSignature,safeTypedData} from './monad-safe-signatures.mjs';
const host='127.0.0.1',port=18555,origin=`http://${host}:${port}`;
const payloadPath=new URL('../contracts/cache/monad-mainnet-governance-plan.json',import.meta.url);
const signaturesPath=new URL('../contracts/cache/monad-mainnet-governance-signatures.json',import.meta.url);
const payload=JSON.parse(readFileSync(payloadPath,'utf8'));
const deployment=JSON.parse(readFileSync(new URL('../contracts/cache/monad-mainnet-deployment.json',import.meta.url),'utf8'));
const zero='0x0000000000000000000000000000000000000000';
const expected={
 acceptOwner:[deployment.adapter,encodeFunctionData({abi:parseAbi(['function acceptOwner()']),functionName:'acceptOwner'})],
 acceptArbitrator:[deployment.adapter,encodeFunctionData({abi:parseAbi(['function acceptArbitrator()']),functionName:'acceptArbitrator'})],
 setRelayer:[deployment.mirror,encodeFunctionData({abi:parseAbi(['function setRelayer(address)']),functionName:'setRelayer',args:[payload.relayer]})],
 setPaused:[deployment.adapter,encodeFunctionData({abi:parseAbi(['function setPaused(bool)']),functionName:'setPaused',args:[false]})],
};
if(payload.chainId!==143||payload.safe.toLowerCase()!==deployment.safe.toLowerCase()||payload.calls.length!==4||payload.calls.map(c=>c.method).join()!==Object.keys(expected).join())throw new Error('Unexpected Safe governance plan');
for(const [i,call] of payload.calls.entries()){
 const [to,data]=expected[call.method];
 if(call.domain.chainId!==143||call.domain.verifyingContract.toLowerCase()!==payload.safe.toLowerCase()||call.message.to.toLowerCase()!==to.toLowerCase()||call.message.data!==data||call.message.value!=='0'||call.message.operation!==0||call.message.gasPrice!=='0'||call.message.gasToken!==zero||call.message.refundReceiver!==zero||call.message.nonce!==String(i))throw new Error(`Only the reviewed zero-value governance call is allowed: ${call.method}`);
 safeTypedData(call);
}
let signatures=existsSync(signaturesPath)?JSON.parse(readFileSync(signaturesPath,'utf8')):{};
const data=()=>({...payload,signatures:Object.fromEntries(payload.calls.map(c=>[c.hash,Object.keys(signatures[c.hash]??{})]))});
const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NadBounty - подписи Safe mainnet</title>
<style>body{font:16px/1.5 system-ui;background:#11101b;color:#eee;max-width:860px;margin:40px auto;padding:20px}button{padding:12px 20px;font-size:16px;margin:6px;background:#9c7aff;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.4;cursor:default}code{overflow-wrap:anywhere;color:#d4c1ff}section{padding:20px;background:#211c35;border-radius:12px;margin:20px 0}#status{white-space:pre-wrap}small{color:#bdb6cd}h1{line-height:1.15}li{margin:6px 0}</style>
<h1>NadBounty: подписи Safe (mainnet)</h1><p>Сеть: <strong>Monad Mainnet · 143</strong>. Подписи бесплатны, транзакции отправляет deployer.</p><p>Safe: <code id="safe"></code></p><p>Adapter: <code id="adapter"></code> · ReputationMirror: <code id="mirror"></code></p>
<section><strong>Четыре действия (каждому нужны две подписи владельцев Safe)</strong><ol>
<li><code>acceptOwner()</code> - Safe принимает роль owner адаптера</li>
<li><code>acceptArbitrator()</code> - Safe принимает роль arbitrator</li>
<li><code>setRelayer(<span id="relayer"></span>)</code> - отдельный кошелёк, который переносит репутацию Base/Arc в ReputationMirror</li>
<li><code>setPaused(false)</code> - открыть приём новых заданий (расчёты и выводы работают и при паузе)</li></ol>
<p>Rabby: подписывается сообщение с хэшем (personal_sign), переключать сеть не нужно. Хэш привязан к Monad Mainnet (143), этому Safe и точному действию.</p><div id="counts"></div><ul id="hashes"></ul></section>
<p>Владельцы Safe:</p><ul id="owners"></ul><button id="connect">1. Подключить кошелёк</button><button id="sign" disabled>2. Подписать все 4 действия</button><p>Текущий аккаунт: <code id="account">не подключён</code></p><p id="status">Открой страницу в Chrome с Rabby или MetaMask.</p><small>Подпиши первым владельцем, затем выбери второй аккаунт владельца в кошельке, подключи его и подпиши ещё раз. Страница сохраняет только публичные подписи и проверяет адрес подписанта.</small>
<script>
let payload,current;
const el=id=>document.getElementById(id);const status=s=>el('status').textContent=s;
const complete=()=>payload?.calls.every(c=>payload.signatures[c.hash].length>=payload.requiredSignatures);
function completion(){if(complete()){el('counts').style.color='#8effb1';el('counts').style.fontWeight='bold';el('sign').disabled=true;status('Готово: все 4 действия получили 2 из 2 проверенных подписей. Больше подписывать не нужно.');}}
async function refresh(){payload=await(await fetch('/payload')).json();el('safe').textContent=payload.safe;el('adapter').textContent=payload.adapter;el('mirror').textContent=payload.mirror;el('relayer').textContent=payload.relayer;el('owners').replaceChildren(...payload.owners.map(o=>{const li=document.createElement('li');const code=document.createElement('code');code.textContent=o;li.append(code);return li;}));el('hashes').replaceChildren(...payload.calls.map(c=>{const li=document.createElement('li');li.textContent=c.method+': '+c.hash;return li;}));el('counts').textContent=payload.calls.map(c=>c.method+': '+payload.signatures[c.hash].length+' из 2').join(' · ');}
async function connect(){if(!window.ethereum)throw Error('Открой в браузере с Rabby или MetaMask.');const accounts=await ethereum.request({method:'eth_requestAccounts'});current=accounts[0];el('account').textContent=current;if(!payload.owners.some(o=>o.toLowerCase()===current.toLowerCase()))throw Error('Выбери аккаунт владельца Safe из списка выше.');el('sign').disabled=complete();if(complete()){completion();return;}status('Кошелёк подключён. Подпиши 4 сообщения Safe для Monad Mainnet.');}
el('connect').onclick=()=>connect().catch(e=>{el('sign').disabled=true;status(e.message);});
el('sign').onclick=async()=>{el('sign').disabled=true;try{const accounts=await ethereum.request({method:'eth_accounts'});if(accounts[0]?.toLowerCase()!==current?.toLowerCase())throw Error('Аккаунт изменился. Нажми «Подключить кошелёк» снова.');for(const call of payload.calls){if(payload.signatures[call.hash].some(o=>o.toLowerCase()===current.toLowerCase()))continue;status('Подпиши '+call.method+' в кошельке.');const signature=await ethereum.request({method:'personal_sign',params:[call.hash,current]});const response=await fetch('/signature',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash:call.hash,signature,scheme:'personal_sign'})});const result=await response.json();if(!response.ok)throw Error(result.error);await refresh();}status('Все подписи этого владельца сохранены и проверены. Теперь подключи второго владельца Safe.');}catch(e){status(e.message);}finally{el('sign').disabled=complete();completion();}};
if(window.ethereum)ethereum.on('accountsChanged',()=>{el('sign').disabled=true;status('Аккаунт изменился. Нажми «Подключить кошелёк».');});
refresh().then(completion).catch(e=>status(e.message));
setInterval(()=>refresh().then(completion).catch(()=>{}),3000);
</script></html>`;
const server=createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.headers.host!==`${host}:${port}`||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403);res.end(JSON.stringify({error:'Local origin required'}));return;}
 if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
 if(req.method==='GET'&&req.url==='/payload'){res.end(JSON.stringify(data()));return;}
 if(req.method!=='POST'||req.url!=='/signature'||req.headers.origin!==origin){res.writeHead(404);res.end('{}');return;}
 try{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Request too large');}
  const {hash,signature,scheme='safe'}=JSON.parse(body);const call=payload.calls.find(c=>c.hash===hash);
  if(!call||!/^0x[0-9a-f]{130}$/i.test(signature))throw new Error('Invalid signature payload');
  const {signer,signature:safeSignature}=await recoverSafeSignature(call,signature,scheme);
  if(!payload.owners.some(o=>o.toLowerCase()===signer.toLowerCase()))throw new Error('Signature does not belong to a Safe owner');
  signatures[hash]??={};signatures[hash][signer.toLowerCase()]=safeSignature;
  writeFileSync(signaturesPath,JSON.stringify(signatures,null,2));
  console.log(`${call.method}: verified signature from ${signer}; ${Object.keys(signatures[hash]).length}/2`);
  res.end(JSON.stringify({signer,count:Object.keys(signatures[hash]).length}));
 }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}
});
server.listen(port,host,()=>console.log(`Safe MAINNET signing page: ${origin}. Collects signatures only; no transaction broadcast.`));
