# Running a Galxe or Zealy quest against ArcBounty

Both platforms verify custom on-chain actions the same way: they call an
endpoint the project hosts with a wallet address and read the JSON answer.
Neither requires the chain to appear in its own supported-chain list. That list
is a convenience for projects that do not want to host a check; it was never a
gate, and treating it as one kept this channel closed for a month.

- **Galxe** does it with a REST credential, documented at
  `docs.galxe.com/quest/credential-api/rest-cred/`. Its `CredSource` enum also
  offers `API`, `GRAPHQL`, `SUBGRAPH`, `CONTRACT_QUERY`, `CSV` and
  `GOOGLE_SHEET`. Base and Base Sepolia are in its `Chain` enum; Arc is not,
  which is why Arc goes through REST.
- **Zealy** does it with the `api` task type. Its schema requires only
  `endpoint` and `identifications` - the `network` field is optional, and its
  enum has no Arc entry, so leave it empty and ask for `wallet`.

## The endpoint

```
https://arcbounty.app/api/quest/verify
```

`GET` or `POST`, no auth, CORS open, OPTIONS answered with 204. It lives in the
frontend rather than in `facade-api` because the frontend is already deployed
and its chain config registers Multicall3, so every bounty a verification needs
collapses into one `eth_call`. Measured against a wallet with five completed
bounties: **0.35s**, against Galxe's 5-second ceiling. The same verifier exists
in `facade-api/src/quest.ts` for whenever that service gets deployed; the
frontend copy is the one campaigns should point at.

Address parsing accepts the value with or without its `0x` prefix, from
`?address=`, `?wallet=`, or a JSON body under `address`, `wallet` or
`user.wallet` - Galxe can be configured to send `$addressWithout0x`, and
Zealy's payload shape is set in its task editor rather than published.

### Response

```json
{
  "address": "0x6543555570adf7f38e536b028d9db5973a266115",
  "network": "Arc Testnet",
  "brand": "ArcBounty",
  "took_bounty": 1,
  "submitted_work": 1,
  "submitted_for_other": 1,
  "completed_bounty": 1,
  "posted_bounty": 0,
  "counts": { "taken": 5, "submitted": 5, "submittedForOther": 5, "completed": 5, "posted": 0 }
}
```

Flags are `1`/`0` rather than `true`/`false` so a Galxe expression is just
`return resp.took_bounty`. Adding `?task=<name>` also returns a single
`result` field for platforms with no scripting step.

A chain read that fails answers **503, never a zero**. Telling someone who did
the work that they are ineligible costs a participant and earns a support
message; telling them to retry costs a click. Earned tasks are also remembered
per instance and never downgraded.

## Which task to reward - read this before configuring anything

| Task | True when |
|---|---|
| `took_bounty` | the address appears as provider on at least one bounty |
| `submitted_work` | at least one of those has a submission hash |
| `submitted_for_other` | at least one submission is against a bounty **someone else** posted |
| `completed_bounty` | at least one submission was resolved, i.e. paid out |
| `posted_bounty` | the address posted at least one bounty |

**Do not make `took_bounty` the rewarded task.** Taking a bounty locks it to
that wallet for the rest of its deadline, so a quest that pays for taking pays
people to empty the board: every farmer who takes and walks away removes a
listing that a real worker could have done, and the board renders as a wall of
"taken" with nothing happening. The worker bond in `V4_DESIGN_ANTI_SYBIL.md`
punishes that wallet at `expireBounty` (15%, floor $0.50), but the damage to
the board happens immediately and the bond only pays the poster back.

Reward a **submission** instead - `submitted_for_other` if the quest asks for
someone else's bounty (it almost always should, see below), `submitted_work` if
it genuinely does not care whose. Neither can be farmed by doing nothing,
both are what actually fills the board with content, and anyone who reaches
either has necessarily taken a bounty first. Keep `took_bounty` as a
zero-or-low-XP step in a multi-task quest if a visible early win helps, never
as the reward itself.

`completed_bounty` depends on a poster approving, so it is not fully in the
participant's hands - fine as a bonus tier, wrong as a required task with a
deadline.

### The two-task quest, and why the second task is `submitted_for_other`

The design that works on a board this size is:

1. **Post a bounty** -> `posted_bounty`
2. **Do someone else's** -> `submitted_for_other`

It is self-feeding: every participant adds one listing and consumes one, so the
board does not drain the way it would if the quest only asked people to take
work. On testnet the funding costs the participant nothing real - Arc's gas
token is USDC and Circle's faucet hands it out - so step 1 is not a paywall.

Use `submitted_for_other`, not `submitted_work`, for step 2. `takeBounty()` has
no `msg.sender != poster` check, so a participant can post a bounty, take it
themselves and submit against it, clearing both steps in a closed loop that
adds nothing to the board and interacts with nobody. `submitted_for_other`
compares the bounty's poster against the verified address and is the only task
that actually means "someone else's".

## Galxe: REST credential

In the campaign builder, add a credential of type **REST**:

| Field | Value |
|---|---|
| Endpoint | `https://arcbounty.app/api/quest/verify?address=$address` |
| Method | `GET` |
| Headers | none needed |
| Expression | `function(resp){ return resp.submitted_for_other }` |

Swap the field name in the expression for whichever task the credential is
for. One endpoint serves every task, so a multi-task campaign adds several
credentials pointing at the same URL with different expressions.

Galxe checks CORS with a real OPTIONS preflight before it will save the
campaign, and its docs name a failed preflight as the cause of "the test
succeeded but the save failed". Ours answers 204 with
`Access-Control-Allow-Origin: *` and `Allow-Methods: GET, POST, OPTIONS`, so
this should pass; if a save ever fails, that is the first thing to re-check.

## Zealy: `api` task

| Field | Value |
|---|---|
| `endpoint` | `https://arcbounty.app/api/quest/verify?task=submitted_for_other` |
| `identifications` | `["wallet"]` |
| `network` | leave empty - the enum has no Arc, and the field is optional |
| `apiKey` | leave empty unless `QUEST_API_KEY` is set on the facade |

Zealy does not publish its callback payload shape; it is shown in the task
editor. The endpoint already accepts the address from the query string and
from several body shapes, so it should work as configured - but read what the
editor says the callback sends and confirm against the response before
publishing the quest.

## Verifying before you publish

```bash
curl -s "https://arcbounty.app/api/quest/verify?address=0x6543555570aDf7F38e536B028D9DB5973A266115"
```

That wallet has five completed bounties on Arc Testnet, all posted by someone
else, so `took_bounty`, `submitted_work`, `submitted_for_other` and
`completed_bounty` all come back `1`. A wallet
that has done nothing returns all zeroes rather than an error, which is what a
platform needs in order to say "not eligible yet".

## Base

The same endpoint serves BaseBounty when the deployment is built with
`NEXT_PUBLIC_ARC_NETWORK=base-mainnet` - `network` and `brand` in the response
change with it. On Base you can also skip the REST credential entirely and use
Galxe's native `CONTRACT_QUERY` against the adapter, since `BASE` is in its
chain enum. REST is still simpler to keep in sync with one set of task names
across both chains.
