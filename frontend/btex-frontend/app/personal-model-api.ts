import { brainxFetch } from "./brainx-api";

export type PersonalModelProvider = { id: string; label: string; example_models: string[] };
export type PersonalModelProfile = {
  schema_version: string;
  ready: boolean;
  agent_ready: boolean;
  provider_id: string | null;
  model_id: string | null;
  status: string;
  consent_version: string;
  configured_at: string | null;
  providers: PersonalModelProvider[];
  already?: boolean;
};

export const getPersonalModelProfile = () =>
  brainxFetch<PersonalModelProfile>("/api/v1/model-profile");

export const savePersonalModelProfile = (input: {
  provider_id: string; model_id: string; api_key: string; consent: true; consent_version: string;
}) => brainxFetch<PersonalModelProfile>("/api/v1/model-profile", { method: "PUT", body: input });

export const disablePersonalModelProfile = () =>
  brainxFetch<PersonalModelProfile>("/api/v1/model-profile", { method: "DELETE" });
