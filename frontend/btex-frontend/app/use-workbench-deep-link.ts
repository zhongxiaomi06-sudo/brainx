"use client";

import { useEffect, useRef } from "react";
import { parseWorkbenchDeepLink } from "./workbench-deep-link";

type LinkedJob = { id: string; brainxDecisionId?: string };

export default function useWorkbenchDeepLink<T extends LinkedJob>({
  connected,
  jobs,
  onOpen,
  onCandidate,
}: {
  connected: boolean;
  jobs: T[];
  onOpen: (job: T, kind: "opportunity" | "replay") => void;
  onCandidate: (candidateRef: string, jobRef: string) => void;
}) {
  const handled = useRef(false);
  useEffect(() => {
    if (!connected || handled.current) return;
    const deepLink = parseWorkbenchDeepLink(window.location.search);
    if (!deepLink) { handled.current = true; return; }
    const job = deepLink.kind === "opportunity"
      ? jobs.find(item => item.id === deepLink.objectRef)
      : jobs.find(item => item.brainxDecisionId === deepLink.objectRef);
    handled.current = true;
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("open");
    cleanUrl.searchParams.delete("candidate");
    window.history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    if (job) onOpen(job, deepLink.kind);
    if (deepLink.candidateRef) onCandidate(deepLink.candidateRef, deepLink.objectRef);
  }, [connected, jobs, onCandidate, onOpen]);
}
