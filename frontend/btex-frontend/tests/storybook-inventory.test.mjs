import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = join(frontendRoot, "app");
const storiesRoot = join(appRoot, "stories");

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function exportedComponents(source) {
  const declarations = [
    ...source.matchAll(/^export\s+(?:default\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_]*)/gm),
    ...source.matchAll(/^export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=/gm),
  ];
  return declarations.map((match) => match[1]);
}

test("每个生产组件导出都有 Storybook 场景", () => {
  const productionFiles = walk(appRoot).filter((path) =>
    path.endsWith(".tsx")
    && !path.includes(`${join("app", "stories")}/`)
    && !path.endsWith(`${join("app", "page.tsx")}`)
    && !path.endsWith(`${join("app", "layout.tsx")}`)
    && !path.endsWith(`${join("showcase", "page.tsx")}`)
    && !path.endsWith(`${join("showcase", "editorial", "page.tsx")}`)
    && !path.endsWith(`${join("tech-stack", "page.tsx")}`),
  );
  const inventory = productionFiles.flatMap((path) =>
    exportedComponents(readFileSync(path, "utf8")).map((name) => ({ name, path })),
  );
  const storySource = walk(storiesRoot)
    .filter((path) => path.endsWith(".stories.tsx"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const missing = inventory.filter(({ name }) => !new RegExp(`\\b${name}\\b`).test(storySource));

  assert.ok(inventory.length >= 15, `组件清单异常缩减为 ${inventory.length} 项`);
  assert.deepEqual(
    missing.map(({ name, path }) => `${name} (${relative(frontendRoot, path)})`),
    [],
    "以下生产组件尚未被 Storybook 引用",
  );
});
