import type { Meta, StoryObj } from "@storybook/react-vite";
import { PersonalModelPanel } from "../personal-model-panel";
import type { PersonalModelProfile } from "../personal-model-api";

const profile: PersonalModelProfile = {
  schema_version: "personal_model_profile.v1",
  ready: false,
  agent_ready: true,
  provider_id: null,
  model_id: null,
  status: "UNCONFIGURED",
  consent_version: "model-data-consent.v1",
  configured_at: null,
  providers: [
    { id: "openai", label: "OpenAI", example_models: ["gpt-5.4"] },
    { id: "anthropic", label: "Anthropic", example_models: ["claude-sonnet-4-6"] },
    { id: "google", label: "Google Gemini", example_models: ["gemini-3-flash-preview"] },
    { id: "stepfun", label: "阶跃 StepFun", example_models: ["step-3.5-flash"] },
  ],
};

const meta = {
  title: "业务组件/个人模型",
  component: PersonalModelPanel,
  parameters: { bare: true },
  args: { initialProfile: profile },
} satisfies Meta<typeof PersonalModelPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsEntry: Story = {};
