import { brainxFetch, type BackendOpportunity } from "./brainx-api";

export function getOpportunityDetail(id: string): Promise<BackendOpportunity> {
  return brainxFetch<BackendOpportunity>(`/api/v1/opportunities/${encodeURIComponent(id)}`);
}
