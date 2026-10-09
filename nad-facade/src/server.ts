import {createApp} from './createApp.js';
import {configuration} from './config.js';
try{
  const config=configuration(process.env);const app=await createApp(config);
  app.listen(config.port,'127.0.0.1',()=>console.log(`NadBounty x402 listening on ${config.port}; chain ${config.chainId}`));
}catch{console.error('NadBounty facade startup failed; check network, adapter, treasury and facilitator support');process.exitCode=1;}
