export type WorkbenchDeepLink = {
  kind: "opportunity" | "replay";
  objectRef: string;
  candidateRef: string | null;
};

const safeRef = (value: string | null) => {
  const text = (value || "").trim();
  return text && text.length <= 256 && !/[\u0000-\u001f]/.test(text) ? text : null;
};

export function parseWorkbenchDeepLink(search: string): WorkbenchDeepLink | null {
  const params = new URLSearchParams(search);
  const open = params.get("open") || "";
  const colon = open.indexOf(":");
  if (colon < 1) return null;
  const kind = open.slice(0, colon);
  const objectRef = safeRef(open.slice(colon + 1));
  if ((kind !== "opportunity" && kind !== "replay") || !objectRef) return null;
  return { kind, objectRef, candidateRef: safeRef(params.get("candidate")) };
}
