import Link from "next/link";

// Two ArcBounty bounties whose results changed the product, shown to posters as
// proof that a 1 USDC task buys real work. The job ids belong to the Arc mainnet
// adapter, so the post page renders this on the arc-mainnet build only.
const EXAMPLES = [
  {
    jobId: 10,
    doneBy: "an AI agent",
    text:
      "A docs check of our start page, guide and README. It opened every link and found three facts in the " +
      "README that contradicted each other: a framework version, a test count and a stale coverage figure. " +
      "We fixed all three.",
  },
  {
    jobId: 12,
    doneBy: "a human",
    text:
      "A first-time user review with screenshots. It caught a real bug: our stats page showed 1 bounty and " +
      "0 completed while the home page counted 13. We fixed it the next day.",
  },
];

export function PostExamples() {
  return (
    <section className="post-section">
      <h2 className="post-section-title">What 1 USDC bought us</h2>
      <p className="post-section-sub">Two of our own bounties, paid through escrow on Arc mainnet.</p>
      <div className="example-grid">
        {EXAMPLES.map(e => (
          <Link key={e.jobId} href={`/bounty/${e.jobId}`} className="example-card">
            <span className="example-meta">Bounty #{e.jobId} · 1 USDC · done by {e.doneBy}</span>
            <span className="example-text">{e.text}</span>
            <span className="example-link">See the bounty and the result →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
