import express from 'express';
import {paymentMiddleware,x402ResourceServer} from '@x402/express';
import {HTTPFacilitatorClient} from '@x402/core/server';
import {ExactEvmScheme} from '@x402/evm/exact/server';
import {createPublicClient,http,zeroAddress} from 'viem';
import {BOUNTY_ADAPTER_V48_ABI as abi} from 'arcbounty-agent-sdk';
import {configuration,FACILITATOR} from './config.js';
import {reputationSources} from './reputationSources.js';

export async function createApp(config:ReturnType<typeof configuration>){
  const client=createPublicClient({transport:http(config.rpc,{timeout:15000,retryCount:1})});
  if(await client.getChainId()!==config.chainId)throw Error('RPC chain mismatch');
  const usdc=await client.readContract({address:config.adapter,abi,functionName:'usdc'});
  if(usdc.toLowerCase()!==config.usdc.toLowerCase())throw Error('Adapter USDC mismatch');
  const network=`eip155:${config.chainId}` as const;
  const facilitator=new HTTPFacilitatorClient({url:FACILITATOR});
  const supported=await facilitator.getSupported();
  if(!supported.kinds.some(k=>k.network===network&&k.scheme==='exact'&&k.x402Version===2))throw Error('Facilitator does not support selected network');
  const scheme=new ExactEvmScheme();
  const server=new x402ResourceServer(facilitator).register(network,scheme);
  const app=express();app.disable('x-powered-by');
  app.set('json replacer',(_key:string,value:unknown)=>typeof value==='bigint'?value.toString():value);
  app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/health',(_req,res)=>res.json({ok:true,chainId:config.chainId,adapter:config.adapter,contractVersion:'4.8',payment:'x402-v2-exact',priceUSDC:'0.001'}));
  app.get('/v1/reputation-sources',async(_req,res)=>{
    if(config.chainId!==10143){res.status(503).json({error:'Source evidence endpoint requires its verified testnet target'});return;}
    try{res.json(await reputationSources());}catch{res.status(503).json({error:'Finalized reputation source evidence unavailable'});}
  });
  // Read before requesting payment: nonexistent jobs and RPC failures are never charged.
  app.get('/v1/bounties/:jobId',async(req,res,next)=>{
    if(!/^[1-9]\d{0,29}$/.test(req.params.jobId)){res.status(400).json({error:'Invalid job ID'});return;}
    try{
      const block=await client.getBlock();const jobId=BigInt(req.params.jobId);
      const meta=await client.readContract({address:config.adapter,abi,functionName:'getBountyMeta',args:[jobId],blockNumber:block.number});
      if(meta.poster===zeroAddress){res.status(404).json({error:'Bounty not found'});return;}
      const entries=meta.contest?await client.readContract({address:config.adapter,abi,functionName:'getContestEntries',args:[jobId],blockNumber:block.number}):[];
      res.locals.snapshot={chainId:config.chainId,adapter:config.adapter,contractVersion:'4.8',sourceBlock:block.number,sourceBlockHash:block.hash,meta,entries};
      next();
    }catch{res.status(503).json({error:'Could not read on-chain snapshot'});}
  });
  const price=config.chainId===10143?{amount:'1000',asset:config.usdc,extra:{name:'USDC',version:'2'}}:'$0.001';
  app.use(paymentMiddleware({'GET /v1/bounties/*':{accepts:{scheme:'exact',network,payTo:config.payTo,price,maxTimeoutSeconds:60},description:'Block-pinned NadBounty V4.8 bounty and encrypted entry references',mimeType:'application/json'}},server));
  app.get('/v1/bounties/:jobId',(_req,res)=>res.json(res.locals.snapshot));
  app.use((_req,res)=>{res.status(404).json({error:'Not found'});});
  app.use((_error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(!res.headersSent)res.status(503).json({error:'Payment service unavailable'});});
  return app;
}
