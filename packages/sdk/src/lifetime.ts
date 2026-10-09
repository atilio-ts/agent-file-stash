import type { StashStats } from "./types.js";

export type LifetimeCounters = Pick<
  StashStats,
  "lifetimeSessions" | "lifetimeReads" | "lifetimeBaselineTokens" | "lifetimeSentTokens" | "lifetimeOverheadTokens"
>;

export interface LifetimeView {
  /** True when no session or read has been counted yet */
  empty: boolean;
  sessions: number;
  reads: number;
  baselineTokens: number;
  sentTokens: number;
  overheadTokens: number;
  grossSaved: number;
  netSaved: number;
  /** Net saving divided by sessions, rounded; null when no session was counted */
  netPerSession: number | null;
}

export function lifetimeView(c: LifetimeCounters): LifetimeView {
  const grossSaved = c.lifetimeBaselineTokens - c.lifetimeSentTokens;
  const netSaved = grossSaved - c.lifetimeOverheadTokens;
  return {
    empty: c.lifetimeSessions === 0 && c.lifetimeReads === 0,
    sessions: c.lifetimeSessions,
    reads: c.lifetimeReads,
    baselineTokens: c.lifetimeBaselineTokens,
    sentTokens: c.lifetimeSentTokens,
    overheadTokens: c.lifetimeOverheadTokens,
    grossSaved,
    netSaved,
    netPerSession: c.lifetimeSessions > 0 ? Math.round(netSaved / c.lifetimeSessions) || 0 : null,
  };
}
