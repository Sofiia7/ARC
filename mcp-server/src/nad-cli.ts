#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NadBountyAgent, MONAD_NETWORKS, type MonadNetworkName } from 'arcbounty-agent-sdk';
import { createPublicClient, http, isAddress, type Address, type Hex } from 'viem';
import { createNadMcpServer } from './nad-tools.js';
import { readSpendLimits } from './limits.js';
const pkg=createRequire(import.meta.url)('../package.json') as {version:string};
async function main(){
  const network=process.env.NAD_NETWORK??'monad-testnet';if(!(Object.hasOwn(MONAD_NETWORKS,network)))throw Error('NAD_NETWORK must be monad-testnet or monad-mainnet');
  const raw=process.env.NAD_BOUNTY_ADAPTER_ADDRESS??(network==='monad-testnet'?'0xf88B980B3AB1CD5A2Befd9c0B88B70196f215020':undefined);
  if(!raw||!isAddress(raw))throw Error('Configure NAD_BOUNTY_ADAPTER_ADDRESS for the selected Monad network');
  const config=MONAD_NETWORKS[network as MonadNetworkName],rpcUrl=process.env.NAD_RPC_URL??config.rpcUrl;
  if(await createPublicClient({transport:http(rpcUrl)}).getChainId()!==config.chainId)throw Error('Monad RPC chain mismatch');
  const privateKey=process.env.NAD_PRIVATE_KEY as Hex|undefined;
  const agent=new NadBountyAgent({network:network as MonadNetworkName,bountyAdapterAddress:raw as Address,rpcUrl,privateKey});
  const limits=readSpendLimits({...process.env,ARCBOUNTY_MAX_REWARD_USDC:process.env.NAD_MAX_REWARD_USDC,ARCBOUNTY_MAX_SPEND_USDC:process.env.NAD_MAX_SPEND_USDC});
  const server=createNadMcpServer({agent,hasSigner:!!privateKey,version:pkg.version,limits});await server.connect(new StdioServerTransport());
  console.error(`[nadbounty] ${network}, adapter ${raw}, ${privateKey?`signing as ${agent.address}`:'read-only'}. Gas: MON.`);
}
main().catch(()=>{console.error('[nadbounty] Startup failed. Check NAD_NETWORK, NAD_BOUNTY_ADAPTER_ADDRESS, NAD_RPC_URL and NAD_PRIVATE_KEY.');process.exitCode=1;});
