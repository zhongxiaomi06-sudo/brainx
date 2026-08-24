import DecisionWorkbench from "./workbench";
import ErrorBoundary from "./error-boundary";

export default function Home() {
  return (
    <ErrorBoundary>
      <DecisionWorkbench />
    </ErrorBoundary>
  );
}
