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
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequest = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const requestTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = pages[pageIndex] || null;

  const beginRequest = () => {
    requestController.current?.abort();
    if (requestTimeout.current) clearTimeout(requestTimeout.current);
    const controller = new AbortController();
    requestController.current = controller;
    requestTimeout.current = setTimeout(() => controller.abort(), 12_000);
    return controller;
  };
  const finishRequest = (controller: AbortController) => {
    if (requestController.current !== controller) return;
    if (requestTimeout.current) clearTimeout(requestTimeout.current);
    requestTimeout.current = null;
    requestController.current = null;
  };
  const requestError = (cause: unknown, fallback: string) => cause instanceof DOMException && cause.name === "AbortError"
    ? "请求超时，请重试" : cause instanceof Error ? cause.message : fallback;

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
    requestController.current?.abort();
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
    if (!current?.nextCursor || loading) return;
    const request = searchRequest.current;
    const controller = beginRequest();
    setLoading(true);
    setError(null);
    void getRecommendationPage(current.nextCursor, searchQuery, sort, controller.signal).then(page => {
      if (request !== searchRequest.current) return;
      if (page.runId !== current.runId) throw new Error("推荐运行已变化，请刷新队列");
      setPages(value => [...value.slice(0, pageIndex + 1), page]);
      setPageIndex(pageIndex + 1);
      onShow(page);
    }).catch(cause => {
      if (request === searchRequest.current) setError(requestError(cause, "这一页加载失败"));
    })
      .finally(() => {
        finishRequest(controller);
        if (request === searchRequest.current) setLoading(false);
      });
  };

  const refresh = () => {
    const request = ++searchRequest.current;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const controller = beginRequest();
    setLoading(true);
    setError(null);
    void getRecommendationPage(null, searchQuery, sort, controller.signal).then(page => {
      if (request !== searchRequest.current) return;
      setPages([page]);
      setPageIndex(0);
      setError(null);
      onShow(page);
    }).catch(cause => {
      if (request === searchRequest.current) setError(requestError(cause, "刷新推荐失败"));
    })
      .finally(() => {
        finishRequest(controller);
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
      const controller = beginRequest();
      void getRecommendationPage(null, query, sort, controller.signal).then(page => {
        if (request !== searchRequest.current) return;
        setPages([page]);
        setPageIndex(0);
        onShow(page);
      }).catch(cause => {
        if (request === searchRequest.current) setError(requestError(cause, "搜索失败，请重试"));
      }).finally(() => {
        finishRequest(controller);
        if (request === searchRequest.current) setLoading(false);
      });
    }, 280);
  };

  const changeSort = (value: RecommendationSort) => {
    if (value === sort) return;
    const previousSort = sort;
    const request = ++searchRequest.current;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSort(value);
    setLoading(true);
    setError(null);
    const controller = beginRequest();
    void getRecommendationPage(null, searchQuery, value, controller.signal).then(page => {
      if (request !== searchRequest.current) return;
      setPages([page]);
      setPageIndex(0);
      onShow(page);
    }).catch(cause => {
      if (request === searchRequest.current) {
        setSort(previousSort);
        setError(requestError(cause, "排序失败，请重试"));
      }
    }).finally(() => {
      finishRequest(controller);
      if (request === searchRequest.current) setLoading(false);
    });
  };

  useEffect(() => () => {
    searchRequest.current += 1;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    requestController.current?.abort();
    if (requestTimeout.current) clearTimeout(requestTimeout.current);
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
