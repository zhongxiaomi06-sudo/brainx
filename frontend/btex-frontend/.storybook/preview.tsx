import type { Preview } from "@storybook/react-vite";
import "../app/globals.css";
import "../app/workbench-layout.css";
import "../app/engagement-loop.css";
import "../app/workbench-concept.css";
import "./storybook.css";

if (typeof document !== "undefined") {
  document.body.classList.add("btex-document");
}

const preview: Preview = {
  decorators: [
    (Story, context) => context.parameters.bare
      ? <Story />
      : (
          <div className={`concept-shell storybook-surface ${context.parameters.surfaceClass || ""}`}>
            <Story />
          </div>
        ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // Existing screens still carry contrast debt. Keep every finding visible
      // as a test warning until the product palette is migrated deliberately.
      test: "todo",
    },
    options: {
      storySort: {
        order: ["指南", "基础控件", "业务组件", "流程组件", "组合场景"],
      },
    },
  },
};

export default preview;
