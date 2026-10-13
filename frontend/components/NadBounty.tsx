"use client";

import { getActiveNetwork } from "@/lib/networks";

// Barrel for the Monad (NadBounty) UI. Pages import from "@/components/NadBounty"; the implementation lives in
// NadBoard.tsx, NadPost.tsx and NadDetail.tsx, shared pieces in nadShared.tsx, pure helpers in lib/nadStatus.ts.
export { NadBoard, NadBountyRow } from "./NadBoard";
export { NadPost } from "./NadPost";
export { NadDetail } from "./NadDetail";
export const isNadBuild = () => getActiveNetwork().nativeCurrency.symbol === "MON";
