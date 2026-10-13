import { brainxFetch } from "./brainx-http";
export type SearchBrief = { search_brief: string; version: number; updated_by: string | null; updated_at: string | null };
export const searchBriefApi = {
  load: (jobId: string) => brainxFetch<SearchBrief>(`/api/v1/opportunities/${encodeURIComponent(jobId)}/search-brief`),
  save: (jobId: string, search_brief: string, version: number) =>
    brainxFetch<SearchBrief>(`/api/v1/opportunities/${encodeURIComponent(jobId)}/search-brief`,
      { method: "PUT", body: { search_brief, version } }),
};
