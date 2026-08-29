"use client";

import { useRef, useState } from "react";
import { getRecommendationPage, type RecommendationPage } from "./brainx-recommendation-pages-api";

export function useRecommendationPages(onShow: (page: RecommendationPage) => void) {
  const [pages, setPages] = useState<RecommendationPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const current = pages[pageIndex] || null;

  const show = (nextIndex: number) => {
    const next = pages[nextIndex];
    if (!next) return;
    setPageIndex(nextIndex);
    setError(null);
    onShow(next);
  };

  const reset = (page: RecommendationPage) => {
    setPages([page]);
    setPageIndex(0);
    setError(null);
    onShow(page);
  };

  const previous = () => show(Math.max(0, pageIndex - 1));
  const next = () => {
    const cached = pages[pageIndex + 1];
    if (cached) {
      show(pageIndex + 1);
      return;
    }
    if (!current?.nextCursor || requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    setError(null);
    void getRecommendationPage(current.nextCursor).then(page => {
      if (page.runId !== current.runId) throw new Error("推荐运行已变化，请刷新队列");
      setPages(value => [...value.slice(0, pageIndex + 1), page]);
      setPageIndex(pageIndex + 1);
      onShow(page);
    }).catch(cause => setError(cause instanceof Error ? cause.message : "这一页加载失败"))
      .finally(() => {
        requestInFlight.current = false;
        setLoading(false);
      });
  };

  const refresh = () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    setError(null);
    void getRecommendationPage().then(reset)
      .catch(cause => setError(cause instanceof Error ? cause.message : "刷新推荐失败"))
      .finally(() => {
        requestInFlight.current = false;
        setLoading(false);
      });
  };

  const markNewRun = () => setPages(value => value.map(page => ({ ...page, newRunAvailable: true })));
  const removeJob = (jobId: string) => setPages(value => value.map(page => ({
    ...page,
    totalCount: Math.max(0, page.totalCount - 1),
    jobs: page.jobs.filter(job => job.id !== jobId),
  })));
  const restore = (snapshot: { pages: RecommendationPage[]; pageIndex: number }) => {
    setPages(snapshot.pages);
    setPageIndex(snapshot.pageIndex);
  };

  return { pages, pageIndex, current, loading, error, reset, previous, next, refresh, markNewRun, removeJob, restore };
}
