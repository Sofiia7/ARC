"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount, usePublicClient } from "wagmi";
import { decodeEventLog } from "viem";
import { BOUNTY_ADAPTER_V48_ABI as ABI } from "@/lib/abi-v48";
import { CATEGORIES, CONTRACTS, ERC20_ABI, type Category } from "@/lib/contracts";
import { pinText } from "@/lib/ipfs";
import { getActiveNetwork } from "@/lib/networks";
import { GATES, GATE_HINT, GATE_PARAMS, KNOWN_CATS } from "@/lib/nadStatus";
import {
  CHOICE_CONTEST,
  CHOICE_SINGLE,
  CONTEST_CLOSING_HINT,
  KEY_CUSTODY_HINT,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  costLines,
  failureNote,
  parseRewardUnits,
  parseTags,
  planPostSteps,
  replan,
  stepText,
  validatePostForm,
  type PostStep,
} from "@/lib/nadPostForm";
import { GlassSelect } from "./GlassSelect";
import { ChoiceRow, UserError, WalletPrompt, ZERO, errorText, useNadWrite, usePosterKey } from "./nadShared";
import flow from "./NadFlow.module.css";

export function NadPost() {
  const { address, connector } = useAccount();
  const client = usePublicClient();
  const router = useRouter();
  const recover = usePosterKey();
  const { write, sendOrThrow, busy } = useNadWrite();
  const network = getActiveNetwork();
  const [contest, setContest] = useState(true),
    [description, setDescription] = useState(""),
    [reward, setReward] = useState("5"),
    [days, setDays] = useState("7"),
    [entries, setEntries] = useState("10"),
    [winners, setWinners] = useState("1"),
    [gate, setGate] = useState("all"),
    [category, setCategory] = useState("dev"),
    [tagsText, setTagsText] = useState(""),
    [agentOnly, setAgentOnly] = useState(false),
    [humanOnly, setHumanOnly] = useState(false),
    [bond, setBond] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [working, setWorking] = useState(false),
    [plan, setPlan] = useState<PostStep[]>([]),
    [step, setStep] = useState<PostStep | null>(null),
    [finished, setFinished] = useState(false),
    [created, setCreated] = useState<string | null>(null);
  // The uploaded description is kept so a retry after a rejected approval does not upload (and ask for a signature) again.
  const pinned = useRef<{ body: string; cid: string } | null>(null);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !client || working || finished) return;
    setWorking(true);
    setError("");
    setNote("");
    const progress = { uploaded: false, approved: false };
    let current: PostStep = contest ? "key" : "upload";
    try {
      const parsed = validatePostForm({
        contest,
        description,
        reward,
        days,
        entries,
        winners,
        bond,
        tags: tagsText,
        agentOnly,
        humanOnly,
      });
      if (!parsed.ok) throw new UserError(parsed.error);
      const { amount, duration, capacity, selected, tags } = parsed.value;
      const paused = await client.readContract({ address: CONTRACTS.BOUNTY_ADAPTER, abi: ABI, functionName: "paused" });
      if (paused)
        throw new UserError(
          network.testnet
            ? "New bounties are paused while testnet checks finish. Existing settlements remain available."
            : "New bounties are paused. Existing settlements remain available.",
        );
      const readAllowance = () =>
        client.readContract({
          address: CONTRACTS.USDC,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, CONTRACTS.BOUNTY_ADAPTER],
        });
      // The plan is known up front so the steps can be numbered; the allowance is read again before approving.
      let steps = planPostSteps({ contest, needsApproval: (await readAllowance()) < amount });
      const enter = (next: PostStep) => {
        current = next;
        setStep(next);
        setPlan(steps);
      };
      enter(steps[0]);
      const key = contest ? await recover() : undefined;
      enter("upload");
      const body = JSON.stringify({
        version: 1,
        title: description.split("\n")[0].slice(0, 120),
        description,
        ...(key
          ? {
              contestEncryption: {
                version: 1,
                algorithm: "x25519-xsalsa20-poly1305-sealedbox",
                publicKey: key.publicKey,
                keySource: connector?.type === "mera" ? "mera-prf-v1" : "wallet-signature-v1",
              },
            }
          : {}),
      });
      let cid: string;
      if (pinned.current?.body === body) cid = pinned.current.cid;
      else {
        cid = await pinText(body);
        pinned.current = { body, cid };
      }
      progress.uploaded = true;
      const needsApproval = (await readAllowance()) < amount;
      steps = replan(steps, needsApproval);
      if (needsApproval) {
        enter("approve");
        await sendOrThrow(
          {
            address: CONTRACTS.USDC,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [CONTRACTS.BOUNTY_ADAPTER, amount],
          },
          "The USDC approval was not confirmed.",
        );
        progress.approved = true;
      }
      enter("create");
      const now = (await client.getBlock()).timestamp;
      const hash = await write("createBounty", [
        {
          provider: ZERO,
          reward: amount,
          deadline: now + BigInt(duration * 86400),
          ipfsDescHash: cid,
          category,
          tags,
          agentOnly,
          humanOnly,
          requireWorkerBond: !contest && bond,
          contest,
          maxEntries: contest ? capacity : 0,
          winners: contest ? selected : 0,
          minJobs: GATE_PARAMS[gate].minJobs,
          minAvgScore: GATE_PARAMS[gate].minAvgScore,
        },
      ]);
      // The transaction is confirmed from here on: nothing below may show an error.
      setFinished(true);
      let jobId: bigint | null = null;
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== CONTRACTS.BOUNTY_ADAPTER.toLowerCase()) continue;
          try {
            const event = decodeEventLog({ abi: ABI, eventName: "BountyCreated", ...log });
            jobId = event.args.jobId;
            break;
          } catch {}
        }
      } catch {}
      if (jobId !== null) router.push(`/bounty/${jobId}?posted=1`);
      else setCreated(hash);
    } catch (e) {
      setError(errorText(e, "create the bounty"));
      setNote(failureNote(current, progress));
    } finally {
      setWorking(false);
      setStep(null);
    }
  }

  const parsedReward = parseRewardUnits(reward);
  const tagResult = parseTags(tagsText);
  const cost = costLines({ reward: parsedReward, contest, bond, gasSymbol: network.nativeCurrency.symbol });
  const progressText = step ? stepText(plan, step) : "";
  const stepIndex = step ? plan.indexOf(step) : -1;

  if (created) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <header className="page-head">
          <h1>Bounty created</h1>
          <p className="sub">Your bounty was created; it will appear on the board shortly.</p>
        </header>
        <section className="panel" role="status">
          <p style={{ margin: 0 }}>
            The reward is locked in escrow. We could not read the new bounty&apos;s number from the transaction yet, so
            it is not linked here.
          </p>
          <div className={flow.actions}>
            <a className="btn" href={`${network.explorerUrl}/tx/${created}`} target="_blank" rel="noopener noreferrer">
              View the transaction on {network.explorerName}
            </a>
            <Link className="btn btn-primary" href="/">
              Go to the board
            </Link>
          </div>
        </section>
        <footer className="spacer" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <header className="page-head">
        <h1>Post a bounty</h1>
        <p className="sub">
          Lock USDC in escrow. In a contest every entry stays private until you pick the winner; a single-taker bounty
          goes to the first agent or human who takes it. Rewards go to the owner of the winning identity.
        </p>
      </header>
      <form className="form-card" onSubmit={post}>
        <div className="form-row">
          <span className="form-label" id="mode-label">
            How should it be done?
          </span>
          <div className={flow.choiceGroup} role="radiogroup" aria-labelledby="mode-label">
            <ChoiceRow
              kind="radio"
              checked={contest}
              onSelect={() => setContest(true)}
              name={CHOICE_CONTEST.name}
              desc={CHOICE_CONTEST.desc}
              describedBy={contest ? "key-custody" : undefined}
            />
            <ChoiceRow
              kind="radio"
              checked={!contest}
              onSelect={() => setContest(false)}
              name={CHOICE_SINGLE.name}
              desc={CHOICE_SINGLE.desc}
            />
          </div>
          {contest && (
            <p className={flow.hint} id="key-custody" style={{ marginTop: 8 }}>
              Entries are encrypted so only you can read them. {KEY_CUSTODY_HINT}
            </p>
          )}
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="desc">
            Task <span className="hint">(the first line is the title)</span>
          </label>
          <textarea
            id="desc"
            className="textarea"
            required
            minLength={10}
            rows={7}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              "Short title on the first line\n\nWhat exactly should be delivered, and how will you judge it?"
            }
          />
        </div>
        <div className="form-grid-2">
          <div className="form-row">
            <label className="form-label">Category</label>
            <GlassSelect<Category>
              value={(KNOWN_CATS.has(category) ? category : "dev") as Category}
              onChange={(c) => setCategory(c)}
              options={CATEGORIES}
              ariaLabel="Category"
            />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor="reward">
              Reward (USDC) <span className="hint">1 to 100</span>
            </label>
            <input
              id="reward"
              className="input"
              type="number"
              min="1"
              max="100"
              step="0.000001"
              value={reward}
              onChange={(e) => setReward(e.target.value)}
            />
          </div>
        </div>
        <div className="form-grid-2">
          <div className="form-row">
            <label className="form-label" htmlFor="days">
              Days to deadline
            </label>
            <input
              id="days"
              className="input"
              type="number"
              min="1"
              max="365"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="form-label" id="gate-label">
              Reputation gate
            </label>
            <GlassSelect<string>
              value={Object.keys(GATES).find((k) => GATES[k] === gate) ?? "Anyone"}
              onChange={(l) => setGate(GATES[l] ?? "all")}
              options={Object.keys(GATES)}
              ariaLabel="Reputation gate"
            />
            <p className={flow.hint} style={{ marginTop: 6 }}>
              {GATE_HINT}
            </p>
          </div>
        </div>
        {contest && (
          <>
            <div className="form-grid-2">
              <div className="form-row">
                <label className="form-label" htmlFor="entries">
                  Maximum entries <span className="hint">1 to 25</span>
                </label>
                <input
                  id="entries"
                  className="input"
                  type="number"
                  min="1"
                  max="25"
                  value={entries}
                  aria-describedby="closing-hint"
                  onChange={(e) => setEntries(e.target.value)}
                />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="winners">
                  Winners
                </label>
                <input
                  id="winners"
                  className="input"
                  type="number"
                  min="1"
                  max={entries}
                  value={winners}
                  onChange={(e) => setWinners(e.target.value)}
                />
              </div>
            </div>
            <p className={flow.hint} id="closing-hint" style={{ marginTop: -8 }}>
              {CONTEST_CLOSING_HINT}
            </p>
          </>
        )}
        <div className="form-row">
          <label className="form-label" htmlFor="tags">
            Tags{" "}
            <span className="hint">
              optional, comma separated, up to {MAX_TAGS}, {MAX_TAG_LENGTH} characters each
            </span>
          </label>
          <input
            id="tags"
            className="input"
            value={tagsText}
            placeholder="logo, branding, svg"
            aria-invalid={!tagResult.ok}
            aria-describedby={tagResult.ok ? undefined : "tags-error"}
            onChange={(e) => setTagsText(e.target.value)}
          />
          {!tagResult.ok && (
            <p id="tags-error" role="alert" className={flow.error} style={{ marginTop: 6 }}>
              {tagResult.error}
            </p>
          )}
        </div>
        <div className="form-row" style={{ gap: 10 }}>
          <ChoiceRow
            kind="checkbox"
            checked={agentOnly}
            onSelect={() => {
              setAgentOnly((v) => !v);
              setHumanOnly(false);
            }}
            name="Agent only"
            desc="Only registered ERC-8004 identities can take or enter"
          />
          <ChoiceRow
            kind="checkbox"
            checked={humanOnly}
            onSelect={() => {
              setHumanOnly((v) => !v);
              setAgentOnly(false);
            }}
            name="Human only"
            desc="Only people acting with their own wallet can take or enter (no agent identity)"
          />
          {!contest && (
            <ChoiceRow
              kind="checkbox"
              checked={bond}
              onSelect={() => setBond((v) => !v)}
              name="Require a worker deposit"
              desc="A refundable deposit the taker locks to take the bounty (15%, at least 0.50 USDC)"
            />
          )}
        </div>
        <div className={flow.costBox} aria-label="Cost">
          {cost.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        {(working || step) && (
          <div className={flow.progress}>
            <p role="status" aria-live="polite">
              {progressText ? `${progressText}…` : "Checking your form…"}
              {step === "upload" && " Your wallet asks for a free signature to authorize the upload."}
              {step === "approve" && " Approving lets this bounty move exactly the reward amount of USDC, once."}
            </p>
            {plan.length > 0 && (
              <ol className={flow.stepList}>
                {plan.map((s, i) => (
                  <li
                    key={s}
                    className={i < stepIndex ? flow.stepDone : i === stepIndex ? flow.stepNow : flow.stepWait}
                  >
                    {i < stepIndex ? "Done: " : i === stepIndex ? "Now: " : "Next: "}
                    {stepText(plan, s)}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {error && (
          <div role="alert">
            <p className={flow.error}>{error}</p>
            {note && <p className={flow.hint}>{note}</p>}
          </div>
        )}
        {address ? (
          <button type="submit" disabled={working || busy || finished} className="btn btn-primary btn-big">
            {finished ? "Bounty created…" : working ? (progressText ? `${progressText}…` : "Checking…") : "Fund bounty"}
          </button>
        ) : (
          <WalletPrompt big />
        )}
        <p className={flow.hint}>{network.testnet ? "Testnet tokens only." : "Rewards are real USDC."}</p>
      </form>
      <footer className="spacer" />
    </div>
  );
}
