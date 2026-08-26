import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Production uses Vinext, React Server Components and Cloudflare. Storybook
// renders client components only, so it deliberately has an isolated Vite
// config instead of loading the deployment pipeline from ../vite.config.ts.
export default defineConfig({
  plugins: [react()],
});
