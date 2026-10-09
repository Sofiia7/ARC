/** Vercel Express entry point: initialize verified clients lazily, retry failed cold starts. */
import express from 'express';
import {createApp} from './createApp.js';
import {configuration} from './config.js';
const app=express();app.disable('x-powered-by');
let initialized:ReturnType<typeof createApp>|undefined;
app.use(async(req,res,next)=>{
 try{
  initialized??=createApp(configuration(process.env));
  const handler=await initialized;handler(req,res,next);
 }catch{initialized=undefined;if(!res.headersSent)res.status(503).json({error:'Payment service initialization unavailable'});}
});
export default app;
