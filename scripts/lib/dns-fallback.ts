/**
 * Resolve through public DNS when the system resolver fails.
 *
 * Import this first in any script that must not stall on the local network's
 * DNS. On 2026-09-16 the home router (192.168.1.1) stopped answering DNS while
 * the connection itself stayed up: Node's fetch failed with ENOTFOUND on every
 * host, though the same hosts answered over their IPs in 20 ms.
 *
 * Node's net module looks names up through `dns.lookup` at connect time, so
 * wrapping it covers fetch, viem and everything else in the process. The system
 * resolver is always tried first; only its failure falls through to
 * 1.1.1.1 / 8.8.8.8 (IPv4 answers), and if those fail too the original error
 * is reported unchanged.
 */
import dns from "node:dns";

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

const publicResolver = new dns.Resolver({ timeout: 3_000, tries: 2 });
publicResolver.setServers(["1.1.1.1", "8.8.8.8"]);

const systemLookup = dns.lookup.bind(dns) as (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;

function lookupWithFallback(hostname: string, options: unknown, callback?: unknown): void {
  const cb = (typeof options === "function" ? options : callback) as LookupCallback;
  const opts: dns.LookupOptions =
    typeof options === "number" ? { family: options } : typeof options === "object" && options !== null ? options as dns.LookupOptions : {};

  systemLookup(hostname, opts, (err, address, family) => {
    if (!err) return cb(null, address, family);
    publicResolver.resolve4(hostname, (err4, addresses) => {
      if (err4 || addresses.length === 0) return cb(err);
      if (opts.all) return cb(null, addresses.map(a => ({ address: a, family: 4 })));
      cb(null, addresses[0], 4);
    });
  });
}

(dns as unknown as { lookup: unknown }).lookup = lookupWithFallback;
