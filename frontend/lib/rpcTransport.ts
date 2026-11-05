/** Monad's public RPCs reject JSON-RPC arrays, including single-item batches.
 * This transport setting is independent of on-chain Multicall3 aggregation.
 */
export function rpcTransportOptions(chainId: number, retryCount = 3, retryDelay = 400) {
  return {
    batch: chainId === 143 || chainId === 10143 ? false as const : { wait: 16 },
    retryCount,
    retryDelay,
  };
}
