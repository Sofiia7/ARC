import type { Category } from "./contracts";

// ─── Post templates ──────────────────────────────────────────────────────────
//
// A poster who lands on /post meets an empty form and has to invent a task from
// nothing. These four are rewritten from ArcBounty's own Arc mainnet listings:
// the first-time review (#12) and the docs check (#10), both completed and
// paid, the bug report (#15) and the research list (#11). The ArcBounty
// specifics became {{placeholders}}, and the post page refuses to submit while
// one is left, so a half-filled template never goes on-chain.

export type PostTemplate = {
  id: string;
  title: string;
  /** One line on the template card. */
  pitch: string;
  category: Category;
  /** Comma-separated, the way the form's tags field takes them. */
  tags: string;
  /** Suggested reward in USDC; the poster sets the real one. */
  reward: string;
  days: string;
  humanOnly: boolean;
  description: string;
};

export function getPostTemplates(networkName: string): PostTemplate[] {
  return [
    {
      id: "first-time-review",
      title: "First-time user review",
      pitch: "A newcomer spends 10 minutes on your site and reports what confused them, with screenshots.",
      category: "other",
      tags: "ux, review, feedback",
      reward: "2",
      days: "7",
      humanOnly: true,
      description:
        "Spend 10 minutes on {{your site or app URL}} as someone who has never used it, and tell us what was unclear.\n\n" +
        "1. Start from {{the page a newcomer should open first}} and work out what the product does and how you would use it.\n" +
        "2. Try {{one or two things a new user would do first}}.\n" +
        "3. No payment or real funds are needed.\n\n" +
        "- At least five concrete observations, each with what you expected, what you saw and a screenshot.\n" +
        "- Name your device and browser.\n" +
        "- End with your honest first impression in two or three sentences.\n" +
        "- Generic advice such as \"improve the design\" does not count.\n\n" +
        "**Submit:** the review as Markdown on IPFS, in a gist or as a published post.",
    },
    {
      id: "docs-check",
      title: "Docs check: dead links and stale facts",
      pitch: "Every link opened and every fact checked against the live product.",
      category: "content",
      tags: "docs, qa, links",
      reward: "2",
      days: "7",
      humanOnly: false,
      description:
        "Read {{the docs pages or README to check, as links}} and report what is broken or out of date.\n\n" +
        "- Open every link. Report each one that fails, with the page it is on and its link text.\n" +
        "- Report statements that no longer match the live product, such as an address, a version, a price or a step " +
        "that does not work. Quote the sentence, say what is true now and link the source.\n" +
        "- Wording and style opinions are out of scope.\n" +
        "- If nothing is broken, list every link you checked with its status. A verified clean report is paid too.\n\n" +
        "**Submit:** the findings as Markdown on IPFS or in a gist.",
    },
    {
      id: "test-one-flow",
      title: "Test one flow end to end",
      pitch: "One user flow run on a real device, with repro steps for anything that breaks.",
      category: "other",
      tags: "qa, bug, report",
      reward: "10",
      days: "7",
      humanOnly: true,
      description:
        "Run one flow in {{your app URL}} from start to finish and report what breaks: " +
        "{{the flow, e.g. sign up, connect a wallet and make the first payment}}.\n\n" +
        "- Test on {{the device, browser and wallet to use, or any}}.\n" +
        "- For every problem: steps to reproduce, what you expected, what you saw, and a screenshot or a short recording.\n" +
        "- If the flow works, say so and attach a screenshot of each step. A verified clean run is paid too.\n" +
        "- No attacks, no load testing and no real funds at risk. Report security issues privately to " +
        "{{your security contact}} instead.\n\n" +
        "**Submit:** the report as Markdown on IPFS, in a gist or as a published post.",
    },
    {
      id: "research-list",
      title: "Research list",
      pitch: "A sourced table of the projects, people or examples you need, with one line each on why they fit.",
      category: "data",
      tags: "research",
      reward: "3",
      days: "7",
      humanOnly: false,
      description:
        `Find {{how many}} {{what to find, e.g. projects live on ${networkName} that accept outside pull requests}}.\n\n` +
        "- For each one: its name, one line on what it is, a link that proves it fits and {{anything else you need per row}}.\n" +
        "- Only current results: {{a freshness rule, e.g. active in the last 60 days}}. No duplicates.\n" +
        "- One line per row on why it fits.\n\n" +
        "**Submit:** a Markdown table on IPFS or in a gist.",
    },
  ];
}

const PLACEHOLDER = /\{\{[^{}]*\}\}/;

/** True while a template's {{...}} gap is still in the text. */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** Start and end of the first {{...}} gap, so the textarea can select it. */
export function firstPlaceholder(text: string): [number, number] | null {
  const m = PLACEHOLDER.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}
