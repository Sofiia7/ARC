"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchNadStats, type NadStatsData } from "@/lib/nadBoardApi";

/**
 * Client-side read of GET /api/nad/stats with a short timeout. A failure never throws into the page: callers decide
 * whether to hide the number (home board) or show an error with a retry button (stats page).
 */
export function useNadStats({ timeoutMs = 6000, refreshMs = 60_000 }: { timeoutMs?: number; refreshMs?: number } = {}) {
  const [data, setData] = useState<NadStatsData | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const next = await fetchNadStats({ timeoutMs });
      if (!alive.current) return;
      setData(next);
      setError("");
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "Could not load stats");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [timeoutMs]);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = refreshMs
      ? setInterval(() => {
          if (document.visibilityState === "visible") void load();
        }, refreshMs)
      : undefined;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, refreshMs]);
  const retry = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);
  return { data, error, loading, retry };
}
