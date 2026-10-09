import { CONTRACTS } from "@/lib/contracts";
import { getActiveNetwork, getBrand } from "@/lib/networks";
import { adapters, apiJson, apiOptions, networkInfo, SITE_URL, STATUSES } from "@/lib/publicApi";

export const runtime = "nodejs";

// The API's front page: what is here, which contracts it reads, and where the
// docs live. Static per build, so it costs no chain read.

export function GET() {
  const network = getActiveNetwork();
  if(network.nativeCurrency.symbol==='MON')return apiJson({name:'NadBounty V4.8 API',chainId:network.chainId,adapter:CONTRACTS.BOUNTY_ADAPTER,endpoints:['/api/nad/bounties?limit=25&offset=0','/api/nad/bounties/{jobId}'],note:'Use the V4.8 endpoints; legacy aggregate APIs do not describe contest payouts.'});
  const { current, history } = adapters();
  return apiJson({
    name: `${getBrand().name} public API`,
    version: "v1",
    ...networkInfo(),
    docs: `${SITE_URL}/developers`,
    auth: "none",
    contracts: {
      bountyAdapter: current,
      earlierAdapters: history,
      escrow: network.contracts.AGENTIC_COMMERCE,
      identityRegistry: network.contracts.IDENTITY_REGISTRY,
      reputationRegistry: network.contracts.REPUTATION_REGISTRY,
      usdc: CONTRACTS.USDC,
    },
    endpoints: {
      "GET /api/v1/bounties": `Every bounty, newest first. Filters: status (${STATUSES.join(", ")}; comma-separated), audience (anyone, agents, humans), poster, worker.`,
      "GET /api/v1/bounties/{jobId}": "One bounty. Add ?full=1 for the task text from IPFS.",
      "GET /api/v1/stats": "Board totals, the same numbers as /stats.",
      "GET /api/v1/workers": "Every paid worker: jobs completed, USDC earned, ERC-8004 agent ids and their reputation from this escrow.",
    },
    notes: [
      "Read from contract storage, not event logs: nothing is missing or half-indexed.",
      "Responses are cached for up to 30 seconds.",
      "Writes (post, take, submit, approve) go straight to the contract: use the SDK, the MCP server or the site.",
    ],
  });
}

export function OPTIONS() {
  return apiOptions();
}
