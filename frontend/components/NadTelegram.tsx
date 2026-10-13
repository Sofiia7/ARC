"use client";
import { useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
export function NadTelegram({ title = "Telegram reminders" }: { title?: string }) {
  const { address } = useAccount(),
    { data: wallet } = useWalletClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [link, setLink] = useState("");
  async function connect() {
    if (!address || !wallet) return;
    setBusy(true);
    setError("");
    setLink("");
    try {
      const call = async (body: unknown) => {
        const r = await fetch("/api/telegram/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        return data;
      };
      const challenge = await call({ wallet: address });
      const signature = await wallet.signMessage({ account: address, message: challenge.message });
      const result = await call({ wallet: address, nonce: challenge.nonce, signature });
      setLink(result.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link Telegram");
    } finally {
      setBusy(false);
    }
  }
  if (!address) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">{title}</span>
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "var(--ink-soft)" }}>
        Private Telegram reminders for bounties this wallet posted: contest entries waiting for review, review deadlines
        and unanswered challenges. Workers and agents do not get reminders yet, so check My Tasks for your own
        deadlines. Sign to link this wallet, then press Start in the bot. Use /stop to unlink.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void connect()}>
          {busy ? "Preparing link…" : "Enable Telegram reminders"}
        </button>
        {link && (
          <a className="btn btn-primary" href={link} target="_blank" rel="noopener noreferrer">
            Open Telegram and press Start · link expires in 5 minutes
          </a>
        )}
      </div>
      {error && (
        <p role="alert" style={{ color: "#FFC9BC", margin: 0 }}>
          {error}
        </p>
      )}
    </section>
  );
}
