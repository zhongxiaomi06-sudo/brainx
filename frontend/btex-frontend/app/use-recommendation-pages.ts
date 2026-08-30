"use client";

import { useEffect, useRef, useState } from "react";
import {
  getRecommendationPage, type RecommendationPage, type RecommendationSort,
} from "./brainx-recommendation-pages-api";

export function useRecommendationPages(onShow: (page: RecommendationPage) => void) {
  const [pages, setPages] = useState<RecommendationPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<RecommendationSort>("priority");
  const requestInFlight = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequest = useRef(0);
  const current = pages[pageIndex] || null;

  const show = (nextIndex: number) => {
    const next = pages[nextIndex];
    if (!next) return;
    setPageIndex(nextIndex);
    setError(null);
    onShow(next);
  };

  const reset = (page: RecommendationPage, query = "") => {
    searchRequest.current += 1;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setPages([page]);
    setPageIndex(0);
    setSearchQuery(query);
    setSort(page.sort);
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
    if (!current?.nextCursor || requestInFlight.current || loading) return;
    const request = searchRequest.current;
    requestInFlight.current = true;
    setLoading(true);
    setError(null);
    void getRecommendationPage(current.nextCursor, searchQuery, sort).then(page => {
      if (request !== searchRequest.current) return;
      if (page.runId !== current.runId) throw new Error("推荐运行已变化，请刷新队列");
      setPages(value => [...value.slice(0, pageIndex + 1), page]);
      setPageIndex(pageIndex + 1);
      onShow(page);
    }).catch(cause => {
      if (request === searchRequest.current) setError(cause instanceof Error ? cause.message : "这一页加载失败");
    })
      .finally(() => {
        requestInFlight.current = false;
        if (request === searchRequest.current) setLoading(false);
      });
  };

  const refresh = () => {
    if (requestInFlight.current) return;
    const request = ++searchRequest.current;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    requestInFlight.current = true;
    setLoading(true);
    setError(null);
    void getRecommendationPage(null, searchQuery, sort).then(page => {
      if (request !== searchRequest.current) return;
      setPages([page]);
      setPageIndex(0);
      setError(null);
      onShow(page);
    }).catch(cause => {
      if (request === searchRequest.current) setError(cause instanceof Error ? cause.message : "刷新推荐失败");
    })
      .finally(() => {
        requestInFlight.current = false;
        if (request === searchRequest.current) setLoading(false);
      });
  };

  const search = (value: string) => {
    const query = value.slice(0, 120);
    setSearchQuery(query);
    setLoading(true);
    setError(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const request = ++searchRequest.current;
    searchTimer.current = setTimeout(() => {
      void getRecommendationPage(null, query, sort).then(page => {
        if (request !== searchRequest.current) return;
        setPages([page]);
        setPageIndex(0);
        onShow(page);
      }).catch(cause => {
        if (request === searchRequest.current) setError(cause instanceof Error ? cause.message : "搜索失败，请重试");
      }).finally(() => {
        if (request === searchRequest.current) setLoading(false);
      });
    }, 280);
  };

  const changeSort = (value: RecommendationSort) => {
    if (value === sort || requestInFlight.current) return;
    const previousSort = sort;
    const request = ++searchRequest.current;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSort(value);
    setLoading(true);
    setError(null);
    void getRecommendationPage(null, searchQuery, value).then(page => {
      if (request !== searchRequest.current) return;
      setPages([page]);
      setPageIndex(0);
      onShow(page);
    }).catch(cause => {
      if (request === searchRequest.current) {
        setSort(previousSort);
        setError(cause instanceof Error ? cause.message : "排序失败，请重试");
      }
    }).finally(() => {
      if (request === searchRequest.current) setLoading(false);
    });
  };

  useEffect(() => () => {
    searchRequest.current += 1;
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const markNewRun = () => setPages(value => value.map(page => ({ ...page, newRunAvailable: true })));
  const removeJob = (jobId: string) => setPages(value => value.map(page => ({
    ...page,
    totalCount: Math.max(0, page.totalCount - 1),
    jobs: page.jobs.filter(job => job.id !== jobId),
  })));
  const restore = (snapshot: { pages: RecommendationPage[]; pageIndex: number }) => {
    setPages(snapshot.pages);
    setPageIndex(snapshot.pageIndex);
    setSort(snapshot.pages[snapshot.pageIndex]?.sort || "priority");
  };

  return { pages, pageIndex, current, loading, error, searchQuery, search, sort, changeSort,
    reset, previous, next, refresh, markNewRun, removeJob, restore };
}
