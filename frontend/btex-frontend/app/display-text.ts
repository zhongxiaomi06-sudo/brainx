export function plainDisplayText(value: string, fallback = "待确认") {
  const text = String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}
