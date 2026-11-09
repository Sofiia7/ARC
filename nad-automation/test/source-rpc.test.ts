// Base source RPC failover and safe error logging (incident 2026-11-06..09: the configured Base RPC
// answered HttpRequestError for days, reputation sync stood still and the log showed only the error name).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readFileSync} from 'node:fs';
import {encodeFunctionResult,numberToHex,parseAbi,toFunctionSelector,type Hex} from 'viem';
import {readReputationSource,BASE_PUBLIC_RPC_URLS} from '../src/reputation.js';
import {isNodeFailure,safeErrorFields} from '../src/rpc-errors.js';

const identity='0x1111111111111111111111111111111111111111',reputation='0x2222222222222222222222222222222222222222',adapter='0x3333333333333333333333333333333333333333';
const views=parseAbi(['function getIdentityRegistry() view returns(address)','function identityRegistry() view returns(address)','function reputationRegistry() view returns(address)','function totalBounties() view returns(uint256)']);
const results:Record<string,Hex>={
  [toFunctionSelector('getIdentityRegistry()')]:encodeFunctionResult({abi:views,functionName:'getIdentityRegistry',result:identity}),
  [toFunctionSelector('identityRegistry()')]:encodeFunctionResult({abi:views,functionName:'identityRegistry',result:identity}),
  [toFunctionSelector('reputationRegistry()')]:encodeFunctionResult({abi:views,functionName:'reputationRegistry',result:reputation}),
  [toFunctionSelector('totalBounties()')]:encodeFunctionResult({abi:views,functionName:'totalBounties',result:0n}),
};
const zero32=`0x${'00'.repeat(32)}` as Hex;
const hashOf=(n:bigint,salt=0)=>`0x${(n*1000n+BigInt(salt)).toString(16).padStart(64,'0')}` as Hex;
const block=(n:bigint,hash:Hex)=>({number:numberToHex(n),hash,parentHash:zero32,nonce:'0x0000000000000000',sha3Uncles:zero32,logsBloom:`0x${'00'.repeat(256)}`,transactionsRoot:zero32,stateRoot:zero32,receiptsRoot:zero32,miner:'0x0000000000000000000000000000000000000000',difficulty:'0x0',totalDifficulty:'0x0',extraData:'0x',size:'0x0',gasLimit:'0x0',gasUsed:'0x0',timestamp:'0x1',baseFeePerGas:'0x0',mixHash:zero32,transactions:[],uncles:[]});

type Call={method:string;params:any[]};
type Failure={http:number;text:string}|{rpcError:{code:number;message:string;data?:Hex}};
/** Minimal Base JSON-RPC node on 127.0.0.1 that records every request it receives. */
async function node(opts:{chainId?:number;finalized?:bigint;path?:string;fail?:(call:Call,url:string)=>Failure|undefined;hash?:(n:bigint,read:number)=>Hex}={}){
  const calls:Call[]=[];let blockReads=0,url='';
  const server=createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      const msg=JSON.parse(raw) as Call&{id:number};const call={method:msg.method,params:msg.params};calls.push(call);
      const json=(body:object)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,...body}));};
      const failure=opts.fail?.(call,url);
      if(failure&&'http' in failure){res.writeHead(failure.http,{'content-type':'text/plain'});return res.end(failure.text);}
      if(failure) return json({error:failure.rpcError});
      if(msg.method==='eth_chainId') return json({result:numberToHex(opts.chainId??8453)});
      if(msg.method==='eth_getBlockByNumber'){
        const n=msg.params[0]==='finalized'?(opts.finalized??100n):BigInt(msg.params[0]);
        return json({result:block(n,(opts.hash??(k=>hashOf(k)))(n,blockReads++))});
      }
      const data=String(msg.params[0]?.data??msg.params[0]?.input??'');
      if(msg.method==='eth_call'&&results[data.slice(0,10)]) return json({result:results[data.slice(0,10)]});
      json({error:{code:-32601,message:'method not found'}});
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  url=`http://127.0.0.1:${(server.address() as AddressInfo).port}${opts.path??'/'}`;
  return {url,calls,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
const source=(rpcUrls:string[])=>({chainId:8453 as const,rpcUrls,adapters:[adapter] as `0x${string}`[],identity,reputation} as const);
const down=():Failure=>({http:503,text:'backend unavailable'});

test('the public Base RPCs follow the configured one, in a fixed order',()=>{
  assert.deepEqual([...BASE_PUBLIC_RPC_URLS],['https://mainnet.base.org','https://base-rpc.publicnode.com']);
});

test('a dead configured RPC moves the whole snapshot to the next node',async()=>{
  const a=await node({fail:down}),b=await node({finalized:90n});
  try{
    const failovers:number[]=[];
    const snapshot=await readReputationSource(source([a.url,b.url]),[],(i,error)=>{failovers.push(i);assert.ok(isNodeFailure(error));});
    assert.deepEqual(failovers,[0]);
    assert.equal(snapshot.sourceBlock,90n);assert.equal(snapshot.sourceHash,hashOf(90n));
    assert.equal(b.calls[0].method,'eth_chainId');
  }finally{await a.close();await b.close();}
});

test('a node that dies mid-snapshot is abandoned whole: the next node starts over at its own finalized block',async()=>{
  const a=await node({finalized:100n,fail:call=>call.method==='eth_call'?down():undefined}),b=await node({finalized:90n});
  try{
    let failed:unknown;
    const snapshot=await readReputationSource(source([a.url,b.url]),[],(_,error)=>{failed=error;});
    assert.ok(a.calls.some(c=>c.method==='eth_call'&&c.params[1]===numberToHex(100n)),'node A had started reading at its block 100');
    assert.equal(snapshot.sourceBlock,90n);assert.equal(snapshot.sourceHash,hashOf(90n));
    assert.deepEqual(b.calls.slice(0,2).map(c=>[c.method,c.params?.[0]]),[['eth_chainId',undefined],['eth_getBlockByNumber','finalized']]);
    assert.ok(!JSON.stringify(b.calls).includes(numberToHex(100n)),'no read on node B is pinned to node A\'s block');
    assert.deepEqual(safeErrorFields(failed),{contractFunction:'getIdentityRegistry',status:503,rpcMethod:'eth_call',details:'"backend unavailable"'});
  }finally{await a.close();await b.close();}
});

test('integrity failures and reverts still fail closed and never reach the next RPC',async()=>{
  const cases:[Parameters<typeof node>[0],RegExp][]=[
    [{chainId:1},/Wrong reputation source chain/],
    [{hash:(n,read)=>hashOf(n,read)},/Source snapshot changed/],
    [{fail:call=>call.method==='eth_call'?{rpcError:{code:3,message:'execution reverted',data:'0x'}}:undefined},/reverted/],
  ];
  for(const [opts,expected] of cases){
    const a=await node(opts),b=await node();
    try{
      let error:unknown;
      await assert.rejects(readReputationSource(source([a.url,b.url]),[],()=>assert.fail('no failover expected')).catch(e=>{error=e;throw e;}),expected);
      assert.equal(isNodeFailure(error),false);
      assert.equal(b.calls.length,0,`${expected} must not fall through to another node`);
    }finally{await a.close();await b.close();}
  }
});

test('when every RPC is down the last error is thrown, and its logged fields carry status and method but no URL or key',async()=>{
  const keyA='A'.repeat(24),keyB='B'.repeat(24); // path keys shorter than the generic 32-char token rule
  const echo=(_:Call,url:string):Failure=>({http:503,text:`no capacity for ${url} (key ${url.split('/').at(-1)})`});
  const a=await node({path:`/v1/rpc/${keyA}`,fail:echo}),b=await node({path:`/v1/rpc/${keyB}`,fail:echo});
  try{
    const logged:string[]=[];
    const error=await readReputationSource(source([a.url,b.url]),[],(_,e)=>logged.push(JSON.stringify(safeErrorFields(e,[a.url,b.url])))).then(()=>assert.fail('expected failure'),e=>e as Error);
    assert.ok(error.message.includes(keyB),'viem puts the URL with its path key into message: this is why message is never logged');
    const fields=safeErrorFields(error,[a.url,b.url]);logged.push(JSON.stringify(fields));
    assert.equal(fields.status,503);assert.equal(fields.rpcMethod,'eth_chainId');assert.match(fields.details!,/no capacity for \[redacted\] \(key \[redacted\]\)/);
    for(const line of logged) for(const leak of [keyA,keyB,'127.0.0.1','://','/v1/rpc']) assert.ok(!line.includes(leak),`${leak} leaked into ${line}`);
  }finally{await a.close();await b.close();}
});

test('a JSON-RPC rate limit fails over and logs its code, with URLs and long tokens scrubbed even without a secret list',async()=>{
  const token='t'.repeat(40);
  const a=await node({fail:()=>({rpcError:{code:-32005,message:`rate limit exceeded for ${token}, upgrade at https://provider.example/keys/${token}`}})}),b=await node();
  try{
    let failed:unknown;
    await readReputationSource(source([a.url,b.url]),[],(_,error)=>{failed=error;});
    const fields=safeErrorFields(failed);
    assert.equal(fields.rpcCode,-32005);assert.equal(fields.rpcMethod,'eth_chainId');assert.equal(fields.status,undefined);
    assert.equal(fields.details,'rate limit exceeded for [redacted], upgrade at [url]');
  }finally{await a.close();await b.close();}
});

test('sync.ts logs errors only through safeErrorFields and gives Base the public fallbacks',()=>{
  const src=readFileSync(new URL('../src/sync.ts',import.meta.url),'utf8');
  assert.doesNotMatch(src,/error\.(message|shortMessage|metaMessages|details|url|cause)\b/,'viem error text carries the RPC URL');
  assert.equal(src.match(/safeErrorFields\(error,secrets\)/g)?.length,2,'failover line and final catch');
  assert.match(src,/name==='base-mainnet'\?BASE_PUBLIC_RPC_URLS:\[\]/);
});
