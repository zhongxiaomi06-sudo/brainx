import * as React$1 from "react";
import React, { Children, StrictMode, createContext, createElement, forwardRef, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { AsyncLocalStorage } from "node:async_hooks";
import { decode } from "node:querystring";
import { createRoot } from "react-dom/client";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region node_modules/vinext/dist/shims/head.js
/**
* next/head shim
*
* In the Pages Router, <Head> manages document <head> elements.
* - On the server: collects elements into a module-level array that the
*   dev-server reads after render and injects into the HTML <head>.
* - On the client: reduces all mounted <Head> instances into one deduped
*   document.head projection and applies it with DOM manipulation.
*/
var _ssrHeadChildren = [];
var _getSSRHeadChildren = () => _ssrHeadChildren;
var _resetSSRHeadImpl = () => {
	_ssrHeadChildren = [];
};
/**
* Register ALS-backed state accessors. Called by head-state.ts on import.
* @internal
*/
function _registerHeadStateAccessors(accessors) {
	_getSSRHeadChildren = accessors.getSSRHeadChildren;
	_resetSSRHeadImpl = accessors.resetSSRHead;
}
/** Reset the SSR head collector. Call before render. */
function resetSSRHead() {
	_resetSSRHeadImpl();
}
/** Get collected head HTML. Call after render. */
function getSSRHeadHTML() {
	return reduceHeadChildren(_getSSRHeadChildren()).map((child) => headChildToHTML(child.type, child.props)).filter(Boolean).join("\n  ");
}
/**
* Tags allowed inside <head>. Anything else is silently dropped.
* This prevents injection of dangerous elements like <iframe>, <object>, etc.
*/
var ALLOWED_HEAD_TAGS = new Set([
	"title",
	"meta",
	"link",
	"style",
	"script",
	"base",
	"noscript"
]);
Array.from(ALLOWED_HEAD_TAGS).join(", ");
var META_TYPES = [
	"name",
	"httpEquiv",
	"charSet",
	"itemProp"
];
/** Self-closing tags: no inner content, emit as <tag ... /> */
var SELF_CLOSING_HEAD_TAGS = new Set([
	"meta",
	"link",
	"base"
]);
/** Tags whose content is raw text — closing-tag sequences must be escaped during SSR. */
var RAW_CONTENT_TAGS = new Set(["script", "style"]);
function collectHeadElements(list, child) {
	if (child == null || typeof child === "boolean" || typeof child === "string" || typeof child === "number") return list;
	if (!isValidElement(child)) return list;
	if (child.type === React.Fragment) return Children.toArray(child.props.children).reduce(collectHeadElements, list);
	if (typeof child.type !== "string") return list;
	if (!ALLOWED_HEAD_TAGS.has(child.type)) {
		child.type;
		return list;
	}
	return list.concat(child);
}
function normalizeHeadKey(key) {
	if (key == null || typeof key === "number") return null;
	const normalizedKey = String(key);
	const separatorIndex = normalizedKey.indexOf("$");
	return separatorIndex > 0 ? normalizedKey.slice(separatorIndex + 1) : null;
}
function createUniqueHeadFilter() {
	const keys = /* @__PURE__ */ new Set();
	const tags = /* @__PURE__ */ new Set();
	const metaTypes = /* @__PURE__ */ new Set();
	const metaCategories = /* @__PURE__ */ new Map();
	return (child) => {
		let isUnique = true;
		const normalizedKey = normalizeHeadKey(child.key);
		const hasKey = normalizedKey !== null;
		if (normalizedKey) if (keys.has(normalizedKey)) isUnique = false;
		else keys.add(normalizedKey);
		switch (child.type) {
			case "title":
			case "base":
				if (tags.has(child.type)) isUnique = false;
				else tags.add(child.type);
				break;
			case "meta": {
				const props = child.props;
				for (const metaType of META_TYPES) {
					if (!Object.prototype.hasOwnProperty.call(props, metaType)) continue;
					if (metaType === "charSet") {
						if (metaTypes.has(metaType)) isUnique = false;
						else metaTypes.add(metaType);
						continue;
					}
					const category = props[metaType];
					if (typeof category !== "string") continue;
					let categories = metaCategories.get(metaType);
					if (!categories) {
						categories = /* @__PURE__ */ new Set();
						metaCategories.set(metaType, categories);
					}
					if ((metaType !== "name" || !hasKey) && categories.has(category)) isUnique = false;
					else categories.add(category);
				}
				break;
			}
			default: break;
		}
		return isUnique;
	};
}
function reduceHeadChildren(headChildren) {
	return headChildren.reduce((flattenedChildren, child) => flattenedChildren.concat(Children.toArray(child)), []).reduce(collectHeadElements, []).reverse().filter(createUniqueHeadFilter()).reverse();
}
/**
* Validate an HTML attribute name. Rejects names that could break out of
* the attribute context during SSR serialization, or that represent inline
* event handlers (on*). Only allows alphanumeric characters, hyphens, and
* common data-attribute patterns.
*/
var SAFE_ATTR_NAME_RE = /^[a-zA-Z][a-zA-Z0-9\-:.]*$/;
function isSafeAttrName(name) {
	if (!SAFE_ATTR_NAME_RE.test(name)) return false;
	if (name.length > 2 && name[0] === "o" && name[1] === "n" && name[2] >= "A" && name[2] <= "z") return false;
	return true;
}
/**
* Convert props + tag to an HTML string for SSR head injection.
* Callers must only pass tags that have already been validated against
* ALLOWED_HEAD_TAGS (e.g. via reduceHeadChildren / collectHeadElements).
*/
function headChildToHTML(tag, props) {
	const attrs = [];
	let innerHTML = "";
	const rawHtml = getDangerouslySetInnerHTML(props.dangerouslySetInnerHTML);
	if (rawHtml != null) innerHTML = rawHtml;
	else if (typeof props.children === "string") innerHTML = escapeHTML(props.children);
	else if (Array.isArray(props.children)) innerHTML = escapeHTML(props.children.join(""));
	for (const [key, value] of Object.entries(props)) if (key === "children" || key === "dangerouslySetInnerHTML") continue;
	else if (key === "className") attrs.push(`class="${escapeAttr(String(value))}"`);
	else if (typeof value === "string") {
		if (!isSafeAttrName(key)) continue;
		attrs.push(`${key}="${escapeAttr(value)}"`);
	} else if (typeof value === "boolean" && value) {
		if (!isSafeAttrName(key)) continue;
		attrs.push(key);
	}
	const attrStr = attrs.length ? " " + attrs.join(" ") : "";
	if (SELF_CLOSING_HEAD_TAGS.has(tag)) return `<${tag}${attrStr} data-vinext-head="true" />`;
	if (RAW_CONTENT_TAGS.has(tag) && innerHTML) innerHTML = escapeInlineContent(innerHTML, tag);
	return `<${tag}${attrStr} data-vinext-head="true">${innerHTML}</${tag}>`;
}
function escapeHTML(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
* Escape content that will be placed inside a raw <script> or <style> tag
* during SSR. The HTML parser treats `<\/script>` (or `</style>`) as the end
* of the block regardless of JavaScript string context, so any occurrence
* of `</` followed by the tag name must be escaped.
*
* We replace `<\/script` and `</style` (case-insensitive) with `<\/script`
* and `<\/style` respectively. The `<\/` form is harmless in JS/CSS string
* context but prevents the HTML parser from seeing a closing tag.
*/
function escapeInlineContent(content, tag) {
	const pattern = new RegExp(`<\\/(${tag})`, "gi");
	return content.replace(pattern, "<\\/$1");
}
function getDangerouslySetInnerHTML(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const html = Reflect.get(value, "__html");
	return typeof html === "string" ? html : void 0;
}
//#endregion
//#region node_modules/vinext/dist/shims/dynamic.js
var preloadQueue = [];
/**
* Wait for all pending dynamic() preloads to resolve, then clear the queue.
* Called by the Pages Router SSR handler before rendering.
* No-op for the App Router path which uses React.lazy + Suspense.
*/
function flushPreloads() {
	const pending = preloadQueue.splice(0);
	return Promise.all(pending);
}
//#endregion
//#region node_modules/vinext/dist/utils/base-path.js
/**
* Shared basePath helpers.
*
* Next.js only treats a pathname as being under basePath when it is an exact
* match ("/app") or starts with the basePath followed by a path separator
* ("/app/..."). Prefix-only matches like "/application" must be left intact.
*/
/**
* Check whether a pathname is inside the configured basePath.
*/
function hasBasePath(pathname, basePath) {
	if (!basePath) return false;
	return pathname === basePath || pathname.startsWith(basePath + "/");
}
/**
* Strip the basePath prefix from a pathname when it matches on a segment
* boundary. Returns the original pathname when it is outside the basePath.
*/
function stripBasePath(pathname, basePath) {
	if (!hasBasePath(pathname, basePath)) return pathname;
	return pathname.slice(basePath.length) || "/";
}
//#endregion
//#region node_modules/vinext/dist/shims/internal/router-context.js
/**
* Shim for next/dist/shared/lib/router-context.shared-runtime
*
* Used by: some testing utilities and older libraries.
* Provides the Pages Router context.
*/
var RouterContext = createContext(null);
//#endregion
//#region node_modules/vinext/dist/client/validate-module-path.js
/**
* Defense-in-depth: validate module paths before passing them to dynamic import().
*
* Shared between entry.ts (initial hydration) and router.ts (client-side navigation)
* to ensure all dynamic imports of page/app modules go through the same validation.
*
* Blocks:
* - Non-string or empty values
* - Paths that don't start with `/` or `./` (e.g., `https://evil.com/...`)
* - Protocol URLs (`://`)
* - Protocol-relative URLs (`//...`)
* - Directory traversal (`..`)
*/
function isValidModulePath(p) {
	if (typeof p !== "string" || p.length === 0) return false;
	if (!p.startsWith("/") && !p.startsWith("./")) return false;
	if (p.startsWith("//")) return false;
	if (p.includes("://")) return false;
	if (p.includes("..")) return false;
	return true;
}
//#endregion
//#region node_modules/vinext/dist/client/window-next.js
/**
* Build-time replacement for the vinext package version, injected by the
* Vite plugin via `define` (see `index.ts` — `process.env.__NEXT_VERSION`
* is mirrored from `packages/vinext/package.json#version` so library
* callers that read `process.env.__NEXT_VERSION` see a real value).
*
* In environments where the define did not run (standalone unit tests
* that import this module without going through the plugin), the
* `?? "vinext"` fallback prevents a literal `undefined` from landing on
* `window.next.version`.
*/
var VINEXT_VERSION = "0.0.50";
/**
* Install `window.next` if it has not already been installed in this
* document. Subsequent calls update fields in place so both the Pages
* Router and the App Router bootstraps can call this without clobbering
* each other (e.g. for hybrid `pages/` + `app/` setups).
*
* When called a second time, `router` and `appDir` overwrite the previous
* values. This mirrors Next.js's load order: in a hybrid app the App
* Router's `app-bootstrap.ts` runs after Pages Router's `next.ts` and the
* App Router instance wins.
*
* No module-level cache: we read and write through `window.next` directly
* so that a test (or userland code) that deletes `window.next` cleanly
* resets state.
*/
function installWindowNext(fields) {
	if (typeof window === "undefined") return;
	const existing = window.next;
	if (existing) {
		if (fields.version !== void 0) existing.version = fields.version;
		if (fields.appDir !== void 0) existing.appDir = fields.appDir;
		if (fields.router !== void 0) existing.router = fields.router;
		if (fields.__pendingUrl !== void 0) existing.__pendingUrl = fields.__pendingUrl;
		if (fields.__internal_src_page !== void 0) existing.__internal_src_page = fields.__internal_src_page;
		return;
	}
	window.next = {
		version: fields.version ?? VINEXT_VERSION,
		...fields
	};
}
//#endregion
//#region node_modules/vinext/dist/shims/url-utils.js
/**
* Shared URL utilities for same-origin detection.
*
* Used by link.tsx, navigation.ts, and router.ts to normalize
* same-origin absolute URLs to local paths for client-side navigation.
*/
/**
* If `url` is an absolute same-origin URL, return the local path
* (pathname + search + hash). Returns null for truly external URLs
* or on the server (where origin is unknown).
*/
function toSameOriginPath(url) {
	if (typeof window === "undefined") return null;
	try {
		const parsed = url.startsWith("//") ? new URL(url, window.location.origin) : new URL(url);
		if (parsed.origin === window.location.origin) return parsed.pathname + parsed.search + parsed.hash;
	} catch {}
	return null;
}
/**
* If `url` is an absolute same-origin URL, return the app-relative path
* (basePath stripped from the pathname, if configured). Returns null for
* truly external URLs or on the server.
*/
function toSameOriginAppPath(url, basePath) {
	const localPath = toSameOriginPath(url);
	if (localPath == null || !basePath) return localPath;
	try {
		const parsed = new URL(localPath, "http://vinext.local");
		if (!hasBasePath(parsed.pathname, basePath)) return null;
		return stripBasePath(parsed.pathname, basePath) + parsed.search + parsed.hash;
	} catch {
		return localPath;
	}
}
/**
* Prepend basePath to a local path for browser URLs / fetches.
*/
function withBasePath$1(path, basePath) {
	if (!basePath || !path.startsWith("/") || path.startsWith("http://") || path.startsWith("https://") || path.startsWith("//")) return path;
	return basePath + path;
}
/**
* Resolve a potentially relative href against the current URL.
* Handles: "#hash", "?query", "?query#hash", and relative paths.
*/
function resolveRelativeHref(href, currentUrl, basePath = "") {
	const base = currentUrl ?? (typeof window !== "undefined" ? window.location.href : void 0);
	if (!base) return href;
	if (href.startsWith("/") || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) return href;
	try {
		const resolved = new URL(href, base);
		return (basePath && resolved.pathname === basePath ? "" : basePath ? stripBasePath(resolved.pathname, basePath) : resolved.pathname) + resolved.search + resolved.hash;
	} catch {
		return href;
	}
}
/**
* Convert a local navigation target into the browser URL that should be used
* for history entries, fetches, and onNavigate callbacks.
*/
function toBrowserNavigationHref(href, currentUrl, basePath = "") {
	const resolved = resolveRelativeHref(href, currentUrl, basePath);
	if (!basePath) return withBasePath$1(resolved, basePath);
	if (resolved === "") return basePath;
	if (resolved.startsWith("?") || resolved.startsWith("#")) return basePath + resolved;
	return withBasePath$1(resolved, basePath);
}
function isHashOnlyBrowserUrlChange(href, currentHref, basePath = "") {
	try {
		const current = new URL(currentHref);
		const next = new URL(href, currentHref);
		return stripBasePath(current.pathname, basePath) === stripBasePath(next.pathname, basePath) && current.search === next.search && next.hash !== "";
	} catch {
		return false;
	}
}
//#endregion
//#region node_modules/vinext/dist/utils/domain-locale.js
function normalizeDomainHostname(hostname) {
	if (!hostname) return void 0;
	return hostname.split(",", 1)[0]?.trim().split(":", 1)[0]?.toLowerCase() || void 0;
}
/**
* Match a configured domain either by hostname or locale.
* When both are provided, the checks intentionally use OR semantics so the
* same helper can cover Next.js's hostname lookup and preferred-locale lookup.
* If both are passed, the first domain matching either input wins, so callers
* should pass hostname or detectedLocale, not both.
*/
function detectDomainLocale(domainItems, hostname, detectedLocale) {
	if (!domainItems?.length) return void 0;
	const normalizedHostname = normalizeDomainHostname(hostname);
	const normalizedLocale = detectedLocale?.toLowerCase();
	for (const item of domainItems) if (normalizedHostname === normalizeDomainHostname(item.domain) || normalizedLocale === item.defaultLocale.toLowerCase() || item.locales?.some((locale) => locale.toLowerCase() === normalizedLocale)) return item;
}
function addLocalePrefix(path, locale, localeDefault) {
	const normalizedLocale = locale.toLowerCase();
	if (normalizedLocale === localeDefault.toLowerCase()) return path;
	const pathWithLeadingSlash = path.startsWith("/") ? path : `/${path}`;
	const normalizedPathname = (pathWithLeadingSlash.split(/[?#]/, 1)[0] ?? pathWithLeadingSlash).toLowerCase();
	const localePrefix = `/${normalizedLocale}`;
	if (normalizedPathname === localePrefix || normalizedPathname.startsWith(`${localePrefix}/`)) return path.startsWith("/") ? path : pathWithLeadingSlash;
	return `/${locale}${pathWithLeadingSlash}`;
}
function withBasePath(path, basePath = "") {
	if (!basePath) return path;
	return basePath + path;
}
function getDomainLocaleUrl(url, locale, { basePath, currentHostname, domainItems }) {
	if (!domainItems?.length) return void 0;
	const targetDomain = detectDomainLocale(domainItems, void 0, locale);
	if (!targetDomain) return void 0;
	const currentDomain = detectDomainLocale(domainItems, currentHostname ?? void 0);
	const localizedPath = addLocalePrefix(url, locale, targetDomain.defaultLocale);
	if (currentDomain && normalizeDomainHostname(currentDomain.domain) === normalizeDomainHostname(targetDomain.domain)) return;
	return `${`http${targetDomain.http ? "" : "s"}://`}${targetDomain.domain}${withBasePath(localizedPath, basePath)}`;
}
//#endregion
//#region node_modules/vinext/dist/utils/query.js
function setOwnQueryValue(obj, key, value) {
	Object.defineProperty(obj, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}
function addQueryParam(obj, key, value) {
	if (Object.hasOwn(obj, key)) {
		const current = obj[key];
		setOwnQueryValue(obj, key, Array.isArray(current) ? current.concat(value) : [current, value]);
	} else setOwnQueryValue(obj, key, value);
}
/**
* Merge pathname-derived dynamic route params into a query object.
*
* Route params must win over same-name URL search params so `/posts/123?id=456`
* still exposes `id: "123"` to Pages Router APIs.
*/
function mergeRouteParamsIntoQuery$1(query, params) {
	const merged = { ...query };
	for (const [key, value] of Object.entries(params)) setOwnQueryValue(merged, key, Array.isArray(value) ? [...value] : value);
	return merged;
}
/**
* Parse a URL's query string into a Record, with multi-value keys promoted to arrays.
*/
function parseQueryString(url) {
	const qs = url.split("?")[1];
	if (!qs) return {};
	const params = new URLSearchParams(qs);
	const query = {};
	for (const [key, value] of params) addQueryParam(query, key, value);
	return query;
}
/**
* Convert a Next.js-style query object into URLSearchParams while preserving
* repeated keys for array values.
*
* Ported from Next.js `urlQueryToSearchParams()`:
* https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/querystring.ts
*/
function stringifyUrlQueryParam(param) {
	if (typeof param === "string") return param;
	if (typeof param === "number" && !isNaN(param) || typeof param === "boolean") return String(param);
	return "";
}
function urlQueryToSearchParams(query) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (Array.isArray(value)) {
			for (const item of value) params.append(key, stringifyUrlQueryParam(item));
			continue;
		}
		params.set(key, stringifyUrlQueryParam(value));
	}
	return params;
}
/**
* Append query parameters to a URL while preserving any existing query string
* and fragment identifier.
*/
function appendSearchParamsToUrl(url, params) {
	const hashIndex = url.indexOf("#");
	const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");
	const base = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
	const existingQuery = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);
	const merged = new URLSearchParams(existingQuery);
	for (const [key, value] of params) merged.append(key, value);
	const search = merged.toString();
	return `${base}${search ? `?${search}` : ""}${hash}`;
}
//#endregion
//#region node_modules/vinext/dist/shims/router.js
/**
* next/router shim
*
* Provides useRouter() hook and Router singleton for Pages Router.
* Backed by the browser History API. Supports client-side navigation
* by fetching new page data and re-rendering the React root.
*/
/** basePath from next.config.js, injected by the plugin at build time */
var __basePath$1 = "";
function createRouterEvents() {
	const listeners = /* @__PURE__ */ new Map();
	return {
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, /* @__PURE__ */ new Set());
			listeners.get(event).add(handler);
		},
		off(event, handler) {
			listeners.get(event)?.delete(handler);
		},
		emit(event, ...args) {
			listeners.get(event)?.forEach((handler) => handler(...args));
		}
	};
}
var routerEvents = createRouterEvents();
function resolveUrl(url) {
	if (typeof url === "string") return url;
	let result = url.pathname ?? "/";
	if (url.query) {
		const params = urlQueryToSearchParams(url.query);
		result = appendSearchParamsToUrl(result, params);
	}
	return result;
}
/**
* When `as` is provided, use it as the navigation target. This is a
* simplification: Next.js keeps `url` and `as` as separate values (url for
* data fetching, as for the browser URL). We collapse them because vinext's
* navigateClient() fetches HTML from the target URL, so `as` must be a
* server-resolvable path. Purely decorative `as` values are not supported.
*/
function resolveNavigationTarget(url, as, locale) {
	return applyNavigationLocale(as ?? resolveUrl(url), locale);
}
function getDomainLocales() {
	return window.__NEXT_DATA__?.domainLocales;
}
function getCurrentHostname() {
	return window.location?.hostname;
}
function getDomainLocalePath(url, locale) {
	return getDomainLocaleUrl(url, locale, {
		basePath: __basePath$1,
		currentHostname: getCurrentHostname(),
		domainItems: getDomainLocales()
	});
}
/**
* Apply locale prefix to a URL for client-side navigation.
* Same logic as Link's applyLocaleToHref but reads from window globals.
*/
function applyNavigationLocale(url, locale) {
	if (!locale || typeof window === "undefined") return url;
	if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) return url;
	const domainLocalePath = getDomainLocalePath(url, locale);
	if (domainLocalePath) return domainLocalePath;
	return addLocalePrefix(url, locale, window.__VINEXT_DEFAULT_LOCALE__ ?? "");
}
/** Check if a URL is external (any URL scheme per RFC 3986, or protocol-relative) */
function isExternalUrl(url) {
	return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}
/** Resolve a hash URL to a basePath-stripped app URL for event payloads */
function resolveHashUrl(url) {
	if (typeof window === "undefined") return url;
	if (url.startsWith("#")) return stripBasePath(window.location.pathname, __basePath$1) + window.location.search + url;
	try {
		const parsed = new URL(url, window.location.href);
		return stripBasePath(parsed.pathname, __basePath$1) + parsed.search + parsed.hash;
	} catch {
		return url;
	}
}
/** Check if a href is only a hash change relative to the current URL */
function isHashOnlyChange(href) {
	if (href.startsWith("#")) return true;
	if (typeof window === "undefined") return false;
	return isHashOnlyBrowserUrlChange(href, window.location.href, __basePath$1);
}
/** Scroll to hash target element, or top if no hash */
function scrollToHash(hash) {
	if (!hash || hash === "#") {
		window.scrollTo(0, 0);
		return;
	}
	const el = document.getElementById(hash.slice(1));
	if (el) el.scrollIntoView({ behavior: "auto" });
}
/** Save current scroll position into history state for back/forward restoration */
function saveScrollPosition() {
	const state = window.history.state ?? {};
	window.history.replaceState({
		...state,
		__vinext_scrollX: window.scrollX,
		__vinext_scrollY: window.scrollY
	}, "");
}
/** Restore scroll position from history state */
function restoreScrollPosition$1(state) {
	if (state && typeof state === "object" && "__vinext_scrollY" in state) {
		const { __vinext_scrollX: x, __vinext_scrollY: y } = state;
		requestAnimationFrame(() => window.scrollTo(x, y));
	}
}
var _ssrContext = null;
var _getSSRContext = () => _ssrContext;
var _setSSRContextImpl = (ctx) => {
	_ssrContext = ctx;
};
/**
* Register ALS-backed state accessors. Called by router-state.ts on import.
* @internal
*/
function _registerRouterStateAccessors(accessors) {
	_getSSRContext = accessors.getSSRContext;
	_setSSRContextImpl = accessors.setSSRContext;
}
function setSSRContext(ctx) {
	_setSSRContextImpl(ctx);
}
/**
* Extract param names from a Next.js route pattern.
* E.g., "/posts/[id]" → ["id"], "/docs/[...slug]" → ["slug"],
* "/shop/[[...path]]" → ["path"], "/blog/[year]/[month]" → ["year", "month"]
* Also handles internal format: "/posts/:id" → ["id"], "/docs/:slug+" → ["slug"]
*/
function extractRouteParamNames(pattern) {
	const names = [];
	const bracketMatches = pattern.matchAll(/\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}/g);
	for (const m of bracketMatches) names.push(m[1]);
	if (names.length > 0) return names;
	const colonMatches = pattern.matchAll(/:([^/+*]+)[+*]?/g);
	for (const m of colonMatches) names.push(m[1]);
	return names;
}
function getPathnameAndQuery() {
	if (typeof window === "undefined") {
		const _ssrCtx = _getSSRContext();
		if (_ssrCtx) {
			const query = {};
			for (const [key, value] of Object.entries(_ssrCtx.query)) query[key] = Array.isArray(value) ? [...value] : value;
			return {
				pathname: _ssrCtx.pathname,
				query,
				asPath: _ssrCtx.asPath
			};
		}
		return {
			pathname: "/",
			query: {},
			asPath: "/"
		};
	}
	const resolvedPath = stripBasePath(window.location.pathname, __basePath$1);
	const pathname = window.__NEXT_DATA__?.page ?? resolvedPath;
	const routeQuery = {};
	const nextData = window.__NEXT_DATA__;
	if (nextData && nextData.query && nextData.page) {
		const routeParamNames = extractRouteParamNames(nextData.page);
		for (const key of routeParamNames) {
			const value = nextData.query[key];
			if (typeof value === "string") routeQuery[key] = value;
			else if (Array.isArray(value)) routeQuery[key] = [...value];
		}
	}
	const searchQuery = {};
	const params = new URLSearchParams(window.location.search);
	for (const [key, value] of params) addQueryParam(searchQuery, key, value);
	return {
		pathname,
		query: {
			...searchQuery,
			...routeQuery
		},
		asPath: resolvedPath + window.location.search + window.location.hash
	};
}
/**
* Error thrown when a navigation is superseded by a newer one.
* Matches Next.js's convention of an Error with `.cancelled = true`.
*/
var NavigationCancelledError = class extends Error {
	cancelled = true;
	constructor(route) {
		super(`Abort fetching component for route: "${route}"`);
		this.name = "NavigationCancelledError";
	}
};
/**
* Error thrown after queueing a hard navigation fallback for a known failure
* mode. Callers can use this to avoid scheduling the same hard navigation twice.
*/
var HardNavigationScheduledError = class extends Error {
	hardNavigationScheduled = true;
	constructor(message) {
		super(message);
		this.name = "HardNavigationScheduledError";
	}
};
/**
* Monotonically increasing ID for tracking the current navigation.
* Each call to navigateClient() increments this and captures the value.
* After each async boundary, the navigation checks whether it is still
* the active one. If a newer navigation has started, the stale one
* throws NavigationCancelledError so the caller can emit routeChangeError
* and skip routeChangeComplete.
*
* Replaces the old boolean `_navInProgress` guard which silently dropped
* the second navigation, causing URL/content mismatch.
*/
var _navigationId = 0;
/** AbortController for the in-flight fetch, so superseded navigations abort network I/O. */
var _activeAbortController = null;
function scheduleHardNavigationAndThrow(url, message) {
	if (typeof window === "undefined") throw new HardNavigationScheduledError(message);
	window.location.href = url;
	throw new HardNavigationScheduledError(message);
}
/**
* Perform client-side navigation: fetch the target page's HTML,
* extract __NEXT_DATA__, and re-render the React root.
*
* Throws NavigationCancelledError if a newer navigation supersedes this one.
* Throws on hard-navigation failures (non-OK response, missing data) so the
* caller can distinguish success from failure for event emission.
*/
async function navigateClient(url) {
	if (typeof window === "undefined") return;
	const root = window.__VINEXT_ROOT__;
	if (!root) {
		window.location.href = url;
		return;
	}
	_activeAbortController?.abort();
	const controller = new AbortController();
	_activeAbortController = controller;
	const navId = ++_navigationId;
	/** Check if this navigation is still the active one. If not, throw. */
	function assertStillCurrent() {
		if (navId !== _navigationId) throw new NavigationCancelledError(url);
	}
	try {
		let res;
		try {
			res = await fetch(url, {
				headers: { Accept: "text/html" },
				signal: controller.signal
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw new NavigationCancelledError(url);
			throw err;
		}
		assertStillCurrent();
		if (!res.ok) scheduleHardNavigationAndThrow(url, `Navigation failed: ${res.status} ${res.statusText}`);
		const html = await res.text();
		assertStillCurrent();
		const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*(.*?)<\/script>/);
		if (!match) scheduleHardNavigationAndThrow(url, "Navigation failed: missing __NEXT_DATA__ in response");
		const nextData = JSON.parse(match[1]);
		const { pageProps } = nextData.props;
		let pageModuleUrl = nextData.__vinext?.pageModuleUrl;
		if (!pageModuleUrl) {
			const moduleMatch = html.match(/import\("([^"]+)"\);\s*\n\s*const PageComponent/);
			const altMatch = html.match(/await import\("([^"]+pages\/[^"]+)"\)/);
			pageModuleUrl = moduleMatch?.[1] ?? altMatch?.[1] ?? void 0;
		}
		if (!pageModuleUrl) scheduleHardNavigationAndThrow(url, "Navigation failed: no page module URL found");
		if (!isValidModulePath(pageModuleUrl)) {
			console.error("[vinext] Blocked import of invalid page module path:", pageModuleUrl);
			scheduleHardNavigationAndThrow(url, "Navigation failed: invalid page module path");
		}
		const pageModule = await import(
			/* @vite-ignore */
			pageModuleUrl
);
		assertStillCurrent();
		const PageComponent = pageModule.default;
		if (!PageComponent) scheduleHardNavigationAndThrow(url, "Navigation failed: page module has no default export");
		const React = (await import("react")).default;
		assertStillCurrent();
		let AppComponent = window.__VINEXT_APP__;
		const appModuleUrl = nextData.__vinext?.appModuleUrl;
		if (!AppComponent && appModuleUrl) if (!isValidModulePath(appModuleUrl)) console.error("[vinext] Blocked import of invalid app module path:", appModuleUrl);
		else try {
			AppComponent = (await import(
				/* @vite-ignore */
				appModuleUrl
)).default;
			window.__VINEXT_APP__ = AppComponent;
		} catch {}
		assertStillCurrent();
		let element;
		if (AppComponent) element = React.createElement(AppComponent, {
			Component: PageComponent,
			pageProps
		});
		else element = React.createElement(PageComponent, pageProps);
		element = wrapWithRouterContext(element);
		window.__NEXT_DATA__ = nextData;
		root.render(element);
	} finally {
		if (navId === _navigationId) _activeAbortController = null;
	}
}
/**
* Run navigateClient and handle errors: emit routeChangeError on failure,
* and fall back to a hard navigation for non-cancel errors so the browser
* recovers to a consistent state.
*
* Returns:
* - "completed" — navigation finished, caller should emit routeChangeComplete
* - "cancelled" — superseded by a newer navigation, caller should return true
*   without emitting routeChangeComplete (matches Next.js behaviour)
* - "failed" — genuine error, caller should return false (hard nav is already
*   scheduled as recovery)
*/
async function runNavigateClient(fullUrl, resolvedUrl) {
	try {
		await navigateClient(fullUrl);
		return "completed";
	} catch (err) {
		routerEvents.emit("routeChangeError", err, resolvedUrl, { shallow: false });
		if (err instanceof NavigationCancelledError) return "cancelled";
		if (typeof window !== "undefined" && !(err instanceof HardNavigationScheduledError)) window.location.href = fullUrl;
		return "failed";
	}
}
/**
* Build the full router value object from the current pathname, query, asPath,
* and a set of navigation methods.  Shared by useRouter() (which passes
* hook-derived callbacks) and wrapWithRouterContext() (which passes the Router
* singleton methods) so the shape stays in sync.
*/
function buildRouterValue(pathname, query, asPath, methods) {
	const _ssrState = _getSSRContext();
	const nextData = typeof window !== "undefined" ? window.__NEXT_DATA__ : void 0;
	const locale = typeof window === "undefined" ? _ssrState?.locale : window.__VINEXT_LOCALE__;
	const locales = typeof window === "undefined" ? _ssrState?.locales : window.__VINEXT_LOCALES__;
	const defaultLocale = typeof window === "undefined" ? _ssrState?.defaultLocale : window.__VINEXT_DEFAULT_LOCALE__;
	const domainLocales = typeof window === "undefined" ? _ssrState?.domainLocales : nextData?.domainLocales;
	return {
		pathname,
		route: typeof window !== "undefined" ? nextData?.page ?? pathname : pathname,
		query,
		asPath,
		basePath: __basePath$1,
		locale,
		locales,
		defaultLocale,
		domainLocales,
		isReady: true,
		isPreview: false,
		isFallback: typeof window !== "undefined" && nextData?.isFallback === true,
		...methods,
		events: routerEvents
	};
}
var _beforePopStateCb;
var _lastPathnameAndSearch = typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
if (typeof window !== "undefined") window.addEventListener("popstate", (e) => {
	const browserUrl = window.location.pathname + window.location.search;
	const appUrl = stripBasePath(window.location.pathname, __basePath$1) + window.location.search;
	const isHashOnly = browserUrl === _lastPathnameAndSearch;
	if (_beforePopStateCb !== void 0) {
		if (!_beforePopStateCb({
			url: appUrl,
			as: appUrl,
			options: { shallow: false }
		})) return;
	}
	_lastPathnameAndSearch = browserUrl;
	if (isHashOnly) {
		const hashUrl = appUrl + window.location.hash;
		routerEvents.emit("hashChangeStart", hashUrl, { shallow: false });
		scrollToHash(window.location.hash);
		routerEvents.emit("hashChangeComplete", hashUrl, { shallow: false });
		window.dispatchEvent(new CustomEvent("vinext:navigate"));
		return;
	}
	const fullAppUrl = appUrl + window.location.hash;
	routerEvents.emit("routeChangeStart", fullAppUrl, { shallow: false });
	routerEvents.emit("beforeHistoryChange", fullAppUrl, { shallow: false });
	(async () => {
		if (await runNavigateClient(browserUrl, fullAppUrl) === "completed") {
			routerEvents.emit("routeChangeComplete", fullAppUrl, { shallow: false });
			restoreScrollPosition$1(e.state);
			window.dispatchEvent(new CustomEvent("vinext:navigate"));
		}
	})();
});
/**
* Wrap a React element in a RouterContext.Provider so that
* next/compat/router's useRouter() returns the real Pages Router value.
*
* This is a plain function, NOT a React component — it builds the router
* value object directly from the current SSR context (server) or
* window.location + Router singleton (client), avoiding duplicate state
* that a hook-based component would create.
*/
function wrapWithRouterContext(element) {
	const { pathname, query, asPath } = getPathnameAndQuery();
	const routerValue = buildRouterValue(pathname, query, asPath, {
		push: Router.push,
		replace: Router.replace,
		back: Router.back,
		reload: Router.reload,
		prefetch: Router.prefetch,
		beforePopState: Router.beforePopState
	});
	return createElement(RouterContext.Provider, { value: routerValue }, element);
}
var Router = {
	push: async (url, as, options) => {
		let resolved = resolveNavigationTarget(url, as, options?.locale);
		if (isExternalUrl(resolved)) {
			const localPath = toSameOriginAppPath(resolved, __basePath$1);
			if (localPath == null) {
				window.location.assign(resolved);
				return true;
			}
			resolved = localPath;
		}
		const full = toBrowserNavigationHref(resolved, window.location.href, __basePath$1);
		if (isHashOnlyChange(full)) {
			const eventUrl = resolveHashUrl(full);
			routerEvents.emit("hashChangeStart", eventUrl, { shallow: options?.shallow ?? false });
			const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
			window.history.pushState({}, "", resolved.startsWith("#") ? resolved : full);
			_lastPathnameAndSearch = window.location.pathname + window.location.search;
			scrollToHash(hash);
			routerEvents.emit("hashChangeComplete", eventUrl, { shallow: options?.shallow ?? false });
			window.dispatchEvent(new CustomEvent("vinext:navigate"));
			return true;
		}
		saveScrollPosition();
		routerEvents.emit("routeChangeStart", resolved, { shallow: options?.shallow ?? false });
		routerEvents.emit("beforeHistoryChange", resolved, { shallow: options?.shallow ?? false });
		window.history.pushState({}, "", full);
		_lastPathnameAndSearch = window.location.pathname + window.location.search;
		if (!options?.shallow) {
			const result = await runNavigateClient(full, resolved);
			if (result === "cancelled") return true;
			if (result === "failed") return false;
		}
		routerEvents.emit("routeChangeComplete", resolved, { shallow: options?.shallow ?? false });
		const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
		if (hash) scrollToHash(hash);
		else if (options?.scroll !== false) window.scrollTo(0, 0);
		window.dispatchEvent(new CustomEvent("vinext:navigate"));
		return true;
	},
	replace: async (url, as, options) => {
		let resolved = resolveNavigationTarget(url, as, options?.locale);
		if (isExternalUrl(resolved)) {
			const localPath = toSameOriginAppPath(resolved, __basePath$1);
			if (localPath == null) {
				window.location.replace(resolved);
				return true;
			}
			resolved = localPath;
		}
		const full = toBrowserNavigationHref(resolved, window.location.href, __basePath$1);
		if (isHashOnlyChange(full)) {
			const eventUrl = resolveHashUrl(full);
			routerEvents.emit("hashChangeStart", eventUrl, { shallow: options?.shallow ?? false });
			const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
			window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : full);
			_lastPathnameAndSearch = window.location.pathname + window.location.search;
			scrollToHash(hash);
			routerEvents.emit("hashChangeComplete", eventUrl, { shallow: options?.shallow ?? false });
			window.dispatchEvent(new CustomEvent("vinext:navigate"));
			return true;
		}
		routerEvents.emit("routeChangeStart", resolved, { shallow: options?.shallow ?? false });
		routerEvents.emit("beforeHistoryChange", resolved, { shallow: options?.shallow ?? false });
		window.history.replaceState({}, "", full);
		_lastPathnameAndSearch = window.location.pathname + window.location.search;
		if (!options?.shallow) {
			const result = await runNavigateClient(full, resolved);
			if (result === "cancelled") return true;
			if (result === "failed") return false;
		}
		routerEvents.emit("routeChangeComplete", resolved, { shallow: options?.shallow ?? false });
		const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
		if (hash) scrollToHash(hash);
		else if (options?.scroll !== false) window.scrollTo(0, 0);
		window.dispatchEvent(new CustomEvent("vinext:navigate"));
		return true;
	},
	back: () => window.history.back(),
	reload: () => window.location.reload(),
	prefetch: async (url) => {
		if (typeof document !== "undefined") {
			const link = document.createElement("link");
			link.rel = "prefetch";
			link.href = url;
			link.as = "document";
			document.head.appendChild(link);
		}
	},
	beforePopState: (cb) => {
		_beforePopStateCb = cb;
	},
	events: routerEvents
};
if (typeof window !== "undefined") installWindowNext({ router: Router });
//#endregion
//#region node_modules/vinext/dist/shims/internal/als-registry.js
/**
* Shared helper for registering AsyncLocalStorage instances on `globalThis`
* via `Symbol.for(...)` so that they survive multiple module instances.
*
* Why this helper exists
* ----------------------
* Vite's multi-environment setup (RSC / SSR / client) and HMR can load a
* single source module under several different specifiers, producing more
* than one module instance at runtime. If each instance kept its own
* module-local `new AsyncLocalStorage()`, request-scoped state would silently
* fork across instances — `headers()` in one environment wouldn't see what
* `connection()` registered in another, concurrent requests would stomp each
* other, etc.
*
* The fix every shim was applying inline:
*
*   const _ALS_KEY = Symbol.for("vinext.foo.als");
*   const _g = globalThis as unknown as Record<PropertyKey, unknown>;
*   const _als = (_g[_ALS_KEY] ??=
*     new AsyncLocalStorage<T>()) as AsyncLocalStorage<T>;
*
* This helper packages that pattern.
*
* Cross-bundle singleton property — preserved
* -------------------------------------------
* - `Symbol.for(key)` consults the global symbol registry and returns the
*   same symbol regardless of which module instance calls it.
* - `globalThis[sym]` is a single slot shared by every module instance.
* - `??=` only assigns when the slot is empty, so the first caller wins and
*   every subsequent caller (in any module instance) reads the same ALS.
*
* The helper module itself never holds the ALS by reference — it always
* round-trips through `globalThis`. So even if this helper file is itself
* loaded under multiple module instances, every copy still hands back the
* one true ALS for a given key.
*/
var _g$10 = globalThis;
/**
* Get (or lazily create) the AsyncLocalStorage registered on `globalThis`
* under `Symbol.for(key)`. Multiple callers — including callers in different
* module instances — that pass the same `key` receive the same ALS instance.
*
* @param key - String key fed to `Symbol.for(...)`. By convention vinext
*   shims use a dotted namespace such as `"vinext.cache.als"`.
*/
function getOrCreateAls(key) {
	const sym = Symbol.for(key);
	return _g$10[sym] ??= new AsyncLocalStorage();
}
//#endregion
//#region node_modules/vinext/dist/shims/unified-request-context.js
var _REQUEST_CONTEXT_ALS_KEY = Symbol.for("vinext.requestContext.als");
var _g$9 = globalThis;
var _als$7 = getOrCreateAls("vinext.unifiedRequestContext.als");
function _getInheritedExecutionContext() {
	const unifiedStore = _als$7.getStore();
	if (unifiedStore) return unifiedStore.executionContext;
	return _g$9[_REQUEST_CONTEXT_ALS_KEY]?.getStore() ?? null;
}
/**
* Create a fresh `UnifiedRequestContext` with defaults for all fields.
* Pass partial overrides for the fields you need to pre-populate.
*/
function createRequestContext(opts) {
	return {
		headersContext: null,
		actionRevalidationKind: 0,
		dynamicUsageDetected: false,
		invalidDynamicUsageError: null,
		pendingSetCookies: [],
		draftModeCookieHeader: null,
		phase: "render",
		i18nContext: null,
		serverContext: null,
		serverInsertedHTMLCallbacks: [],
		requestScopedCacheLife: null,
		unstableCacheRevalidation: "foreground",
		_privateCache: null,
		currentRequestTags: [],
		currentFetchSoftTags: [],
		currentFetchCacheMode: null,
		isFetchDedupeActive: false,
		currentFetchDedupeEntries: /* @__PURE__ */ new Map(),
		executionContext: _getInheritedExecutionContext(),
		requestCache: /* @__PURE__ */ new WeakMap(),
		ssrContext: null,
		ssrHeadChildren: [],
		rootParams: null,
		...opts
	};
}
function runWithRequestContext(ctx, fn) {
	return _als$7.run(ctx, fn);
}
function runWithUnifiedStateMutation(mutate, fn) {
	const parentCtx = _als$7.getStore();
	if (!parentCtx) return fn();
	const childCtx = { ...parentCtx };
	mutate(childCtx);
	return _als$7.run(childCtx, fn);
}
/**
* Get the current unified request context.
* Returns the ALS store when inside a `runWithRequestContext()` scope,
* or a fresh detached context otherwise. Unlike the legacy per-shim fallback
* singletons, this detached value is ephemeral — mutations do not persist
* across calls. This is intentional to prevent state leakage outside request
* scopes.
*
* Only direct callers observe this detached fallback. Shim `_getState()`
* helpers should continue to gate on `isInsideUnifiedScope()` and fall back
* to their standalone ALS/fallback singletons outside the unified scope.
* If called inside a standalone `runWithExecutionContext()` scope, the
* detached context still reflects that inherited `executionContext`.
*/
function getRequestContext() {
	return _als$7.getStore() ?? createRequestContext();
}
/**
* Check whether the current execution is inside a `runWithRequestContext()` scope.
* Shim modules use this to decide whether to read from the unified store
* or fall back to their own standalone ALS.
*/
function isInsideUnifiedScope() {
	return _als$7.getStore() != null;
}
//#endregion
//#region node_modules/vinext/dist/shims/request-context.js
/**
* Request ExecutionContext — AsyncLocalStorage-backed accessor.
*
* Makes the Cloudflare Workers `ExecutionContext` (which provides
* `waitUntil`) available to any code on the call stack during a request
* without requiring it to be threaded through every function signature.
*
* Usage:
*
*   // In the worker entry, wrap the handler:
*   import { runWithExecutionContext } from "vinext/shims/request-context";
*   export default {
*     fetch(request, env, ctx) {
*       return runWithExecutionContext(ctx, () => handler.fetch(request, env, ctx));
*     }
*   };
*
*   // Anywhere downstream:
*   import { getRequestExecutionContext } from "vinext/shims/request-context";
*   const ctx = getRequestExecutionContext(); // null on Node.js dev
*   ctx?.waitUntil(somePromise);
*/
var _als$6 = getOrCreateAls("vinext.requestContext.als");
function runWithExecutionContext(ctx, fn) {
	if (isInsideUnifiedScope()) return runWithUnifiedStateMutation((uCtx) => {
		uCtx.executionContext = ctx;
	}, fn);
	return _als$6.run(ctx, fn);
}
/**
* Get the `ExecutionContext` for the current request, or `null` when called
* outside a `runWithExecutionContext()` scope (e.g. on Node.js dev server).
*
* Use `ctx?.waitUntil(promise)` to schedule background work that must
* complete before the Worker isolate is torn down.
*/
function getRequestExecutionContext() {
	if (isInsideUnifiedScope()) return getRequestContext().executionContext;
	return _als$6.getStore() ?? null;
}
//#endregion
//#region node_modules/vinext/dist/server/headers.js
/**
* Internal HTTP header name constants used throughout vinext.
*
* Centralizes all custom header names so they are defined once and referenced
* everywhere via imports. Keeping them in one module prevents typos, makes
* rename-refactors trivial, and lets grep find every consumer instantly.
*
* Standard HTTP headers (Content-Type, Cache-Control, etc.) are intentionally
* omitted — only vinext-internal and Next.js-protocol headers belong here.
*/
/** ISR / page cache state indicator: "HIT" | "MISS" | "STALE" | "STATIC". */
var VINEXT_CACHE_HEADER = "X-Vinext-Cache";
/** Deduplicated, sorted list of mounted layout slots for cache keying. */
var VINEXT_MOUNTED_SLOTS_HEADER = "X-Vinext-Mounted-Slots";
/** Route interception context for parallel/intercepting routes. */
var VINEXT_INTERCEPTION_CONTEXT_HEADER = "X-Vinext-Interception-Context";
/** RSC render mode (e.g. "navigation", "prefetch"). */
var VINEXT_RSC_RENDER_MODE_HEADER = "X-Vinext-Rsc-Render-Mode";
var NEXT_ROUTER_STATE_TREE_HEADER = "Next-Router-State-Tree";
var NEXT_ROUTER_PREFETCH_HEADER = "Next-Router-Prefetch";
var NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = "Next-Router-Segment-Prefetch";
var NEXT_URL_HEADER = "Next-Url";
//#endregion
//#region node_modules/vinext/dist/shims/headers.js
var _FALLBACK_KEY$6 = Symbol.for("vinext.nextHeadersShim.fallback");
var _g$8 = globalThis;
getOrCreateAls("vinext.nextHeadersShim.als");
_g$8[_FALLBACK_KEY$6] ??= {
	headersContext: null,
	dynamicUsageDetected: false,
	invalidDynamicUsageError: null,
	pendingSetCookies: [],
	draftModeCookieHeader: null,
	phase: "render"
};
(/* @__PURE__ */ new Date(0)).toUTCString();
(/* @__PURE__ */ new Date(0)).toUTCString();
//#endregion
//#region node_modules/vinext/dist/utils/hash.js
/**
* FNV-1a hash producing a 64-bit result (two 32-bit rounds with different seeds).
* Used for deterministic key generation where collisions must be rare.
*/
function fnv1a64(input) {
	let h1 = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h1 ^= input.charCodeAt(i);
		h1 = h1 * 16777619 >>> 0;
	}
	let h2 = 84696351;
	for (let i = 0; i < input.length; i++) {
		h2 ^= input.charCodeAt(i);
		h2 = h2 * 16777619 >>> 0;
	}
	return h1.toString(36) + h2.toString(36);
}
new AsyncLocalStorage();
//#endregion
//#region node_modules/vinext/dist/utils/cache-control-metadata.js
function isUnknownRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readRecordField(ctx, field) {
	const value = ctx?.[field];
	return isUnknownRecord(value) ? value : void 0;
}
function readCacheControlNumberField(ctx, field) {
	const value = readRecordField(ctx, "cacheControl")?.[field] ?? ctx?.[field];
	return typeof value === "number" ? value : void 0;
}
//#endregion
//#region node_modules/vinext/dist/utils/encode-cache-tag.js
/**
* Cache-tag canonicalisation.
*
* Tags can flow into HTTP headers (e.g. `x-next-cache-tags` on ISR responses,
* Cloudflare cache-tag headers, downstream Worker code) where Node's
* `validateHeaderValue` rejects any byte outside `\t\x20-\x7e` and crashes
* the response with `ERR_INVALID_CHAR`. Even on platforms with permissive
* header setters, divergence between storage form and wire form silently
* breaks invalidation when a `revalidateTag` call's tag does not byte-match
* the form that was stored.
*
* The fix is to apply this encoding at every public boundary so storage,
* comparison, and the wire all see the same ASCII-safe form. The fast-path
* returns the input unchanged for already-ASCII tags (the common case), so
* pre-encoded `%xx` input round-trips losslessly without `decodeURIComponent`
* mangling literal `%xx` characters.
*
* The replacement matches *runs* of out-of-class code units rather than each
* code unit individually so surrogate pairs (emoji, non-BMP characters) are
* handed to `encodeURIComponent` as a complete code point — a per-code-unit
* regex would split the pair and throw `URIError`.
*
* Mirrors Next.js's `packages/next/src/server/lib/encode-cache-tag.ts`
* (introduced in vercel/next.js#93601).
*/
var OUT_OF_CLASS_CHAR = /[^\t\x20-\x7e]/;
var OUT_OF_CLASS_RUN = /[^\t\x20-\x7e]+/g;
function encodeCacheTag(tag) {
	return OUT_OF_CLASS_CHAR.test(tag) ? tag.replace(OUT_OF_CLASS_RUN, (run) => encodeURIComponent(run)) : tag;
}
function encodeCacheTags(tags) {
	return tags.map(encodeCacheTag);
}
function readStringArrayField(ctx, field) {
	const value = ctx?.[field];
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}
var MemoryCacheHandler = class {
	store = /* @__PURE__ */ new Map();
	tagRevalidatedAt = /* @__PURE__ */ new Map();
	async get(key, _ctx) {
		const entry = this.store.get(key);
		if (!entry) return null;
		for (const tag of entry.tags) {
			const revalidatedAt = this.tagRevalidatedAt.get(tag);
			if (revalidatedAt && revalidatedAt >= entry.lastModified) {
				this.store.delete(key);
				return null;
			}
		}
		for (const tag of readStringArrayField(_ctx, "softTags")) {
			const revalidatedAt = this.tagRevalidatedAt.get(tag);
			if (revalidatedAt && revalidatedAt >= entry.lastModified) return null;
		}
		if (entry.expireAt !== null && Date.now() > entry.expireAt) {
			this.store.delete(key);
			return null;
		}
		if (entry.revalidateAt !== null && Date.now() > entry.revalidateAt) return {
			lastModified: entry.lastModified,
			value: entry.value,
			cacheState: "stale",
			cacheControl: entry.cacheControl
		};
		return {
			lastModified: entry.lastModified,
			value: entry.value,
			cacheControl: entry.cacheControl
		};
	}
	async set(key, data, ctx) {
		const tagSet = /* @__PURE__ */ new Set();
		if (data && "tags" in data && Array.isArray(data.tags)) for (const t of data.tags) tagSet.add(t);
		for (const t of readStringArrayField(ctx, "tags")) tagSet.add(t);
		const tags = [...tagSet];
		let effectiveRevalidate;
		let effectiveExpire;
		effectiveRevalidate = readCacheControlNumberField(ctx, "revalidate");
		effectiveExpire = readCacheControlNumberField(ctx, "expire");
		if (data && "revalidate" in data && typeof data.revalidate === "number") effectiveRevalidate = data.revalidate;
		if (effectiveRevalidate === 0) return;
		const now = Date.now();
		const revalidateAt = typeof effectiveRevalidate === "number" && effectiveRevalidate > 0 ? now + effectiveRevalidate * 1e3 : null;
		const expireAt = typeof effectiveExpire === "number" && effectiveExpire > 0 ? now + effectiveExpire * 1e3 : null;
		const cacheControl = typeof effectiveRevalidate === "number" ? effectiveExpire === void 0 ? { revalidate: effectiveRevalidate } : {
			revalidate: effectiveRevalidate,
			expire: effectiveExpire
		} : void 0;
		this.store.set(key, {
			value: data,
			tags,
			lastModified: now,
			revalidateAt,
			expireAt,
			cacheControl
		});
	}
	async revalidateTag(tags, _durations) {
		const tagList = Array.isArray(tags) ? tags : [tags];
		const now = Date.now();
		for (const tag of tagList) this.tagRevalidatedAt.set(tag, now);
	}
	resetRequestCache() {}
};
var _HANDLER_KEY = Symbol.for("vinext.cacheHandler");
var _gHandler = globalThis;
function _getActiveHandler() {
	return _gHandler[_HANDLER_KEY] ?? (_gHandler[_HANDLER_KEY] = new MemoryCacheHandler());
}
/**
* Get the active CacheHandler (for internal use or testing).
*/
function getCacheHandler() {
	return _getActiveHandler();
}
/**
* A fulfilled thenable that React can unwrap synchronously via `use()`
* without ever suspending. Reusing a single instance avoids allocating
* on every call — matching Next.js's browser/client implementation.
*
* @see https://github.com/vercel/next.js/blob/canary/packages/next/src/client/request/io.browser.ts
*/
var _resolvedIOPromise = Promise.resolve(void 0);
_resolvedIOPromise.status = "fulfilled";
_resolvedIOPromise.value = void 0;
var _FALLBACK_KEY$5 = Symbol.for("vinext.cache.fallback");
var _g$7 = globalThis;
var _cacheAls = getOrCreateAls("vinext.cache.als");
_g$7[_FALLBACK_KEY$5] ??= {
	actionRevalidationKind: 0,
	requestScopedCacheLife: null,
	unstableCacheRevalidation: "foreground"
};
var ACTION_DID_NOT_REVALIDATE = 0;
function _runWithCacheState(fn) {
	if (isInsideUnifiedScope()) return runWithUnifiedStateMutation((uCtx) => {
		uCtx.actionRevalidationKind = ACTION_DID_NOT_REVALIDATE;
		uCtx.requestScopedCacheLife = null;
		uCtx.unstableCacheRevalidation = "foreground";
	}, fn);
	const state = {
		actionRevalidationKind: ACTION_DID_NOT_REVALIDATE,
		requestScopedCacheLife: null,
		unstableCacheRevalidation: "foreground"
	};
	return _cacheAls.run(state, fn);
}
getOrCreateAls("vinext.unstableCache.als");
getOrCreateAls("vinext.cacheRuntime.contextAls");
var _PRIVATE_FALLBACK_KEY = Symbol.for("vinext.cacheRuntime.privateFallback");
var _g$6 = globalThis;
var _privateAls = getOrCreateAls("vinext.cacheRuntime.privateAls");
_g$6[_PRIVATE_FALLBACK_KEY] ??= { _privateCache: /* @__PURE__ */ new Map() };
function runWithPrivateCache(fn) {
	if (isInsideUnifiedScope()) return runWithUnifiedStateMutation((uCtx) => {
		uCtx._privateCache = /* @__PURE__ */ new Map();
	}, fn);
	const state = { _privateCache: /* @__PURE__ */ new Map() };
	return _privateAls.run(state, fn);
}
//#endregion
//#region node_modules/vinext/dist/shims/fetch-cache.js
/**
* Extended fetch() with Next.js caching semantics.
*
* Patches `globalThis.fetch` during server rendering to support:
*
*   fetch(url, { next: { revalidate: 60, tags: ['posts'] } })
*   fetch(url, { cache: 'force-cache' })
*   fetch(url, { cache: 'no-store' })
*
* Cached responses are stored via the pluggable CacheHandler, so
* revalidateTag() and revalidatePath() invalidate fetch-level caches.
*
* Usage (in server entry):
*   import { withFetchCache, cleanupFetchCache } from './fetch-cache';
*   const cleanup = withFetchCache();
*   try { ... render ... } finally { cleanup(); }
*
* Or use the async helper:
*   await runWithFetchCache(async () => { ... render ... });
*/
/**
* Headers excluded from the cache key. These are W3C trace context headers
* that can break request caching and deduplication.
* All other headers ARE included in the cache key, matching Next.js behavior.
*/
var HEADER_BLOCKLIST = ["traceparent", "tracestate"];
var CACHE_KEY_PREFIX = "v3";
var MAX_CACHE_KEY_BODY_BYTES = 1024 * 1024;
var BodyTooLargeForCacheKeyError = class extends Error {
	constructor() {
		super("Fetch body too large for cache key generation");
	}
};
var SkipCacheKeyGenerationError = class extends Error {
	constructor() {
		super("Fetch body could not be serialized for cache key generation");
	}
};
/**
* Collect all headers from the request, excluding the blocklist.
* Merges headers from both the Request object and the init object,
* with init taking precedence (matching fetch() spec behavior).
*/
function collectHeaders(input, init) {
	const merged = {};
	if (input instanceof Request && input.headers) input.headers.forEach((v, k) => {
		merged[k] = v;
	});
	if (init?.headers) (init.headers instanceof Headers ? init.headers : new Headers(init.headers)).forEach((v, k) => {
		merged[k] = v;
	});
	for (const blocked of HEADER_BLOCKLIST) delete merged[blocked];
	return merged;
}
/**
* Check whether a fetch request carries any per-user auth headers.
* Used for the safety bypass (skip caching when auth headers are present
* without an explicit cache opt-in).
*/
var AUTH_HEADERS = [
	"authorization",
	"cookie",
	"x-api-key"
];
function hasAuthHeaders(input, init) {
	const headers = collectHeaders(input, init);
	return AUTH_HEADERS.some((name) => name in headers);
}
async function serializeFormData(formData, pushBodyChunk, getTotalBodyBytes) {
	for (const [key, val] of formData.entries()) {
		if (typeof val === "string") {
			pushBodyChunk(JSON.stringify([key, {
				kind: "string",
				value: val
			}]));
			continue;
		}
		if (val.size > MAX_CACHE_KEY_BODY_BYTES || getTotalBodyBytes() + val.size > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
		pushBodyChunk(JSON.stringify([key, {
			kind: "file",
			name: val.name,
			type: val.type,
			value: await val.text()
		}]));
	}
}
function getParsedFormContentType(contentType) {
	const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
	if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return mediaType;
}
function stripMultipartBoundary(contentType) {
	const [type, ...params] = contentType.split(";");
	const keptParams = params.map((param) => param.trim()).filter(Boolean).filter((param) => !/^boundary\s*=/i.test(param));
	const normalizedType = type.trim().toLowerCase();
	return keptParams.length > 0 ? `${normalizedType}; ${keptParams.join("; ")}` : normalizedType;
}
async function readRequestBodyChunksWithinLimit(request) {
	const contentLengthHeader = request.headers.get("content-length");
	if (contentLengthHeader) {
		const contentLength = Number(contentLengthHeader);
		if (Number.isFinite(contentLength) && contentLength > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
	}
	const requestClone = request.clone();
	const contentType = requestClone.headers.get("content-type") ?? void 0;
	const reader = requestClone.body?.getReader();
	if (!reader) return {
		chunks: [],
		contentType
	};
	const chunks = [];
	let totalBodyBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBodyBytes += value.byteLength;
			if (totalBodyBytes > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
			chunks.push(value);
		}
	} catch (err) {
		reader.cancel().catch(() => {});
		throw err;
	}
	return {
		chunks,
		contentType
	};
}
/**
* Serialize request body into string chunks for cache key inclusion.
* Handles all body types: string, Uint8Array, ReadableStream, FormData, Blob,
* and Request object bodies.
* Returns the serialized body chunks and optionally stashes the original body
* on init as `_ogBody` so it can still be used after stream consumption.
*/
async function serializeBody(input, init) {
	if (!init?.body && !(input instanceof Request && input.body)) return { bodyChunks: [] };
	const bodyChunks = [];
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let totalBodyBytes = 0;
	let canonicalizedContentType;
	const pushBodyChunk = (chunk) => {
		totalBodyBytes += encoder.encode(chunk).byteLength;
		if (totalBodyBytes > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
		bodyChunks.push(chunk);
	};
	const getTotalBodyBytes = () => totalBodyBytes;
	if (init?.body instanceof Uint8Array) {
		if (init.body.byteLength > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
		pushBodyChunk(decoder.decode(init.body));
		init._ogBody = init.body;
	} else if (init?.body && typeof init.body.getReader === "function") {
		const [bodyForHashing, bodyForFetch] = init.body.tee();
		init._ogBody = bodyForFetch;
		const reader = bodyForHashing.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (typeof value === "string") pushBodyChunk(value);
				else {
					totalBodyBytes += value.byteLength;
					if (totalBodyBytes > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
					bodyChunks.push(decoder.decode(value, { stream: true }));
				}
			}
			const finalChunk = decoder.decode();
			if (finalChunk) pushBodyChunk(finalChunk);
		} catch (err) {
			await reader.cancel();
			if (err instanceof BodyTooLargeForCacheKeyError) throw err;
			throw new SkipCacheKeyGenerationError();
		}
	} else if (init?.body instanceof URLSearchParams) {
		init._ogBody = init.body;
		pushBodyChunk(init.body.toString());
	} else if (init?.body && typeof init.body.keys === "function") {
		const formData = init.body;
		init._ogBody = init.body;
		await serializeFormData(formData, pushBodyChunk, getTotalBodyBytes);
	} else if (init?.body && typeof init.body.arrayBuffer === "function") {
		const blob = init.body;
		if (blob.size > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
		pushBodyChunk(await blob.text());
		const arrayBuffer = await blob.arrayBuffer();
		init._ogBody = new Blob([arrayBuffer], { type: blob.type });
	} else if (typeof init?.body === "string") {
		if (init.body.length > MAX_CACHE_KEY_BODY_BYTES) throw new BodyTooLargeForCacheKeyError();
		pushBodyChunk(init.body);
		init._ogBody = init.body;
	} else if (input instanceof Request && input.body) {
		let chunks;
		let contentType;
		try {
			({chunks, contentType} = await readRequestBodyChunksWithinLimit(input));
		} catch (err) {
			if (err instanceof BodyTooLargeForCacheKeyError) throw err;
			throw new SkipCacheKeyGenerationError();
		}
		const formContentType = getParsedFormContentType(contentType);
		if (formContentType) try {
			await serializeFormData(await new Request(input.url, {
				method: input.method,
				headers: contentType ? { "content-type": contentType } : void 0,
				body: new Blob(chunks)
			}).formData(), pushBodyChunk, getTotalBodyBytes);
			canonicalizedContentType = formContentType === "multipart/form-data" && contentType ? stripMultipartBoundary(contentType) : void 0;
			return {
				bodyChunks,
				canonicalizedContentType
			};
		} catch (err) {
			if (err instanceof BodyTooLargeForCacheKeyError) throw err;
			throw new SkipCacheKeyGenerationError();
		}
		for (const chunk of chunks) pushBodyChunk(decoder.decode(chunk, { stream: true }));
		const finalChunk = decoder.decode();
		if (finalChunk) pushBodyChunk(finalChunk);
	}
	return {
		bodyChunks,
		canonicalizedContentType
	};
}
/**
* Generate a deterministic cache key from a fetch request.
*
* Matches Next.js behavior: the key is a SHA-256 hash of a JSON array
* containing URL, method, all headers (minus blocklist), all RequestInit
* options, and the serialized body.
*/
async function buildFetchCacheKey(input, init) {
	let url;
	let method = "GET";
	if (typeof input === "string") url = input;
	else if (input instanceof URL) url = input.toString();
	else {
		url = input.url;
		method = input.method || "GET";
	}
	if (init?.method) method = init.method;
	const headers = collectHeaders(input, init);
	const { bodyChunks, canonicalizedContentType } = await serializeBody(input, init);
	if (canonicalizedContentType) headers["content-type"] = canonicalizedContentType;
	const cacheString = JSON.stringify([
		CACHE_KEY_PREFIX,
		url,
		method,
		headers,
		init?.mode,
		init?.redirect,
		init?.credentials,
		init?.referrer,
		init?.referrerPolicy,
		init?.integrity,
		init?.cache,
		bodyChunks
	]);
	const buffer = new TextEncoder().encode(cacheString);
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	return Array.prototype.map.call(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}
var _PENDING_KEY = Symbol.for("vinext.fetchCache.pendingRefetches");
var _gPending = globalThis;
var pendingRefetches = _gPending[_PENDING_KEY] ??= /* @__PURE__ */ new Map();
var DEDUP_TIMEOUT_MS = 6e4;
var _ORIG_FETCH_KEY = Symbol.for("vinext.fetchCache.originalFetch");
var _gFetch = globalThis;
var originalFetch = _gFetch[_ORIG_FETCH_KEY] ??= globalThis.fetch;
var _FALLBACK_KEY$4 = Symbol.for("vinext.fetchCache.fallback");
var _g$5 = globalThis;
var _als$4 = getOrCreateAls("vinext.fetchCache.als");
var _noop = () => {};
var _responseBodyRegistry;
if (globalThis.FinalizationRegistry) _responseBodyRegistry = new FinalizationRegistry((weakRef) => {
	const stream = weakRef.deref();
	if (stream && !stream.locked) stream.cancel("Response object has been garbage collected").then(_noop, _noop);
});
var _fallbackState$4 = _g$5[_FALLBACK_KEY$4] ??= {
	currentRequestTags: [],
	currentFetchSoftTags: [],
	currentFetchCacheMode: null,
	isFetchDedupeActive: false,
	currentFetchDedupeEntries: /* @__PURE__ */ new Map()
};
function _getState$4() {
	if (isInsideUnifiedScope()) return getRequestContext();
	return _als$4.getStore() ?? _fallbackState$4;
}
function isNoStoreFetch(cacheDirective, nextOpts) {
	return cacheDirective === "no-store" || cacheDirective === "no-cache" || nextOpts?.revalidate === false || nextOpts?.revalidate === 0;
}
function isCacheableFetch(cacheDirective, nextOpts) {
	return cacheDirective === "force-cache" || typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0;
}
function hasExplicitRevalidateValue(nextOpts) {
	return nextOpts?.revalidate !== void 0;
}
function resolveSegmentCacheDirective(cacheDirective, nextOpts, mode) {
	if (!mode || mode === "auto") return cacheDirective;
	switch (mode) {
		case "force-cache": return "force-cache";
		case "force-no-store": return "no-store";
		case "only-cache":
			if (isNoStoreFetch(cacheDirective, nextOpts)) throw new Error("Route segment config `fetchCache = \"only-cache\"` conflicts with no-store fetch.");
			return cacheDirective ?? "force-cache";
		case "only-no-store":
			if (isCacheableFetch(cacheDirective, nextOpts)) throw new Error("Route segment config `fetchCache = \"only-no-store\"` conflicts with cacheable fetch.");
			return cacheDirective ?? "no-store";
		case "default-cache": return cacheDirective ?? (hasExplicitRevalidateValue(nextOpts) ? void 0 : "force-cache");
		case "default-no-store": return cacheDirective ?? (hasExplicitRevalidateValue(nextOpts) ? void 0 : "no-store");
	}
	return cacheDirective;
}
function getFetchCacheDirective(input, init) {
	if (init?.cache !== void 0) return init.cache;
	if (!(input instanceof Request) || input.cache === "default") return;
	return input.cache;
}
function buildFetchDedupeKey(request) {
	const filteredHeaders = Array.from(request.headers.entries()).filter(([key]) => !HEADER_BLOCKLIST.includes(key.toLowerCase()));
	return JSON.stringify([
		request.method,
		filteredHeaders,
		request.mode,
		request.redirect,
		request.credentials,
		request.referrer,
		request.referrerPolicy,
		request.integrity
	]);
}
function createFetchDedupeCandidate(input, init) {
	if (init?.signal) return null;
	const method = init?.method?.toUpperCase();
	if (method && method !== "GET" && method !== "HEAD") return null;
	if (init?.keepalive) return null;
	const request = typeof input === "string" || input instanceof URL ? new Request(input, init) : input;
	if (request.method !== "GET" && request.method !== "HEAD" || request.keepalive) return null;
	return {
		url: request.url,
		key: buildFetchDedupeKey(request)
	};
}
function buildDedupeClone(body, source) {
	const cloned = new Response(body, {
		status: source.status,
		statusText: source.statusText,
		headers: new Headers(source.headers)
	});
	Object.defineProperty(cloned, "url", {
		value: source.url,
		configurable: true,
		enumerable: true,
		writable: false
	});
	if (_responseBodyRegistry && cloned.body) _responseBodyRegistry.register(cloned, new WeakRef(cloned.body));
	return cloned;
}
function cloneDedupeResponse(response) {
	if (!response.body) return [buildDedupeClone(null, response), buildDedupeClone(null, response)];
	const [body1, body2] = response.body.tee();
	return [buildDedupeClone(body1, response), buildDedupeClone(body2, response)];
}
function dedupeFetch(input, init) {
	const state = _getState$4();
	if (!state.isFetchDedupeActive) return originalFetch(input, init);
	const candidate = createFetchDedupeCandidate(input, init);
	if (!candidate) return originalFetch(input, init);
	const entriesByUrl = state.currentFetchDedupeEntries;
	let entries = entriesByUrl.get(candidate.url);
	if (!entries) {
		entries = [];
		entriesByUrl.set(candidate.url, entries);
	}
	for (const entry of entries) {
		if (entry.key !== candidate.key) continue;
		return entry.promise.then(() => {
			if (!entry.response) throw new Error("[vinext] Missing deduped fetch response");
			const [responseForCaller, responseForFutureCaller] = cloneDedupeResponse(entry.response);
			entry.response = responseForFutureCaller;
			return responseForCaller;
		});
	}
	const promise = originalFetch(input, init);
	const entry = {
		key: candidate.key,
		promise,
		response: null
	};
	entries.push(entry);
	return promise.then((response) => {
		const [responseForCaller, responseForFutureCaller] = cloneDedupeResponse(response);
		entry.response = responseForFutureCaller;
		return responseForCaller;
	}, (err) => {
		const idx = entries.indexOf(entry);
		if (idx !== -1) entries.splice(idx, 1);
		throw err;
	});
}
/**
* Create a patched fetch function with Next.js caching semantics.
*
* The patched fetch:
* 1. Checks `cache` and `next` options to determine caching behavior
* 2. On cache hit, returns the cached response without hitting the network
* 3. On cache miss, fetches from network, stores in cache, returns response
* 4. Respects `next.revalidate` for TTL-based revalidation
* 5. Respects `next.tags` for tag-based invalidation via revalidateTag()
*/
function createPatchedFetch() {
	return async function patchedFetch(input, init) {
		const nextOpts = init?.next;
		const cacheDirective = resolveSegmentCacheDirective(getFetchCacheDirective(input, init), nextOpts, _getState$4().currentFetchCacheMode);
		if (!nextOpts && !cacheDirective) return dedupeFetch(input, init);
		if (cacheDirective === "no-store" || cacheDirective === "no-cache" || nextOpts?.revalidate === false || nextOpts?.revalidate === 0) return dedupeFetch(input, stripNextFromInit(init, cacheDirective));
		if (!(cacheDirective === "force-cache" || typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0) && hasAuthHeaders(input, init)) return dedupeFetch(input, stripNextFromInit(init, cacheDirective));
		let revalidateSeconds;
		if (cacheDirective === "force-cache") revalidateSeconds = nextOpts?.revalidate && typeof nextOpts.revalidate === "number" ? nextOpts.revalidate : 31536e3;
		else if (typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0) revalidateSeconds = nextOpts.revalidate;
		else if (nextOpts?.tags && nextOpts.tags.length > 0) revalidateSeconds = 31536e3;
		else return dedupeFetch(input, stripNextFromInit(init, cacheDirective));
		const tags = encodeCacheTags(nextOpts?.tags ?? []);
		const softTags = _getState$4().currentFetchSoftTags;
		let fetchInit = stripNextFromInit(init, cacheDirective);
		let cacheKey;
		try {
			cacheKey = await buildFetchCacheKey(input, fetchInit);
			fetchInit = stripNextFromInit(fetchInit, cacheDirective);
		} catch (err) {
			if (err instanceof BodyTooLargeForCacheKeyError || err instanceof SkipCacheKeyGenerationError) {
				fetchInit = stripNextFromInit(fetchInit, cacheDirective);
				return dedupeFetch(input, fetchInit);
			}
			throw err;
		}
		const handler = getCacheHandler();
		const reqTags = _getState$4().currentRequestTags;
		if (tags.length > 0) {
			for (const tag of tags) if (!reqTags.includes(tag)) reqTags.push(tag);
		}
		try {
			const cached = await handler.get(cacheKey, {
				kind: "FETCH",
				tags,
				softTags
			});
			if (cached?.value && cached.value.kind === "FETCH" && cached.cacheState !== "stale") {
				const cachedData = cached.value.data;
				return new Response(cachedData.body, {
					status: cachedData.status ?? 200,
					headers: cachedData.headers
				});
			}
			if (cached?.value && cached.value.kind === "FETCH" && cached.cacheState === "stale") {
				const staleData = cached.value.data;
				if (!pendingRefetches.has(cacheKey)) {
					const refetchPromise = originalFetch(input, fetchInit).then(async (freshResp) => {
						if (freshResp.status !== 200) return;
						const freshBody = await freshResp.text();
						const freshHeaders = {};
						freshResp.headers.forEach((v, k) => {
							if (k.toLowerCase() === "set-cookie") return;
							freshHeaders[k] = v;
						});
						const freshValue = {
							kind: "FETCH",
							data: {
								headers: freshHeaders,
								body: freshBody,
								url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
								status: freshResp.status
							},
							tags,
							revalidate: revalidateSeconds
						};
						await handler.set(cacheKey, freshValue, {
							fetchCache: true,
							tags,
							revalidate: revalidateSeconds
						});
					}).catch((err) => {
						const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
						console.error(`[vinext] fetch cache background revalidation failed for ${url} (key=${cacheKey.slice(0, 12)}...):`, err);
					}).finally(() => {
						if (pendingRefetches.get(cacheKey) === refetchPromise) pendingRefetches.delete(cacheKey);
						clearTimeout(timeoutId);
					});
					pendingRefetches.set(cacheKey, refetchPromise);
					const timeoutId = setTimeout(() => {
						if (pendingRefetches.get(cacheKey) === refetchPromise) pendingRefetches.delete(cacheKey);
					}, DEDUP_TIMEOUT_MS);
					getRequestExecutionContext()?.waitUntil(refetchPromise);
				}
				return new Response(staleData.body, {
					status: staleData.status ?? 200,
					headers: staleData.headers
				});
			}
		} catch (cacheErr) {
			console.error("[vinext] fetch cache read error:", cacheErr);
		}
		const response = await dedupeFetch(input, fetchInit);
		if (response.status === 200) {
			const cloned = response.clone();
			const body = await cloned.text();
			const headers = {};
			cloned.headers.forEach((v, k) => {
				if (k.toLowerCase() === "set-cookie") return;
				headers[k] = v;
			});
			const cacheValue = {
				kind: "FETCH",
				data: {
					headers,
					body,
					url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
					status: cloned.status
				},
				tags,
				revalidate: revalidateSeconds
			};
			handler.set(cacheKey, cacheValue, {
				fetchCache: true,
				tags,
				revalidate: revalidateSeconds
			}).catch((err) => {
				console.error("[vinext] fetch cache write error:", err);
			});
		}
		return response;
	};
}
/**
* Strip the `next` property from RequestInit before passing to real fetch.
* The `next` property is not a standard fetch option and would cause warnings
* in some environments.
*/
function stripNextFromInit(init, cacheOverride) {
	if (!init) return cacheOverride === void 0 ? void 0 : { cache: cacheOverride };
	const { next: _next, _ogBody, ...rest } = init;
	if (cacheOverride !== void 0) rest.cache = cacheOverride;
	if (_ogBody !== void 0) rest.body = _ogBody;
	return Object.keys(rest).length > 0 ? rest : void 0;
}
var _PATCH_KEY = Symbol.for("vinext.fetchCache.patchInstalled");
function _ensurePatchInstalled() {
	if (_g$5[_PATCH_KEY]) return;
	_g$5[_PATCH_KEY] = true;
	globalThis.fetch = createPatchedFetch();
}
/**
* Run an async function with patched fetch caching enabled.
* Uses `AsyncLocalStorage.run()` for proper per-request isolation
* of collected fetch tags in concurrent server environments.
*/
async function runWithFetchCache(fn) {
	_ensurePatchInstalled();
	if (isInsideUnifiedScope()) return await runWithUnifiedStateMutation((uCtx) => {
		uCtx.currentRequestTags = [];
		uCtx.currentFetchSoftTags = [];
		uCtx.isFetchDedupeActive = true;
		uCtx.currentFetchDedupeEntries = /* @__PURE__ */ new Map();
	}, fn);
	return _als$4.run({
		currentRequestTags: [],
		currentFetchSoftTags: [],
		currentFetchCacheMode: null,
		isFetchDedupeActive: true,
		currentFetchDedupeEntries: /* @__PURE__ */ new Map()
	}, fn);
}
/**
* Install the patched fetch without creating a standalone ALS scope.
*
* `runWithFetchCache()` is the standalone helper: it installs the patch and
* creates an isolated per-request tag store. The unified request context owns
* that isolation itself via `currentRequestTags`, so callers inside
* `runWithRequestContext()` only need the process-global fetch monkey-patch.
*/
function ensureFetchPatch() {
	_ensurePatchInstalled();
}
//#endregion
//#region node_modules/vinext/dist/shims/router-state.js
/**
* Server-only Pages Router state backed by AsyncLocalStorage.
*
* Provides request-scoped isolation for SSR context (pathname, query,
* locale) so concurrent requests on Workers don't share state.
*
* This module is server-only — it imports node:async_hooks and must NOT
* be bundled for the browser.
*/
var _FALLBACK_KEY$3 = Symbol.for("vinext.router.fallback");
var _g$4 = globalThis;
var _als$3 = getOrCreateAls("vinext.router.als");
var _fallbackState$3 = _g$4[_FALLBACK_KEY$3] ??= { ssrContext: null };
function _getState$3() {
	if (isInsideUnifiedScope()) return getRequestContext();
	return _als$3.getStore() ?? _fallbackState$3;
}
_registerRouterStateAccessors({
	getSSRContext() {
		return _getState$3().ssrContext;
	},
	setSSRContext(ctx) {
		_getState$3().ssrContext = ctx;
	}
});
//#endregion
//#region node_modules/vinext/dist/shims/url-safety.js
/**
* Shared URL safety utilities for Link, Form, and navigation shims.
*
* Centralizes dangerous URI scheme detection so all components and
* navigation functions use the same validation logic.
*/
/**
* Detect dangerous URI schemes that should never be navigated to.
*
* Adapted from Next.js's javascript URL detector:
* packages/next/src/client/lib/javascript-url.ts
* https://github.com/vercel/next.js/blob/canary/packages/next/src/client/lib/javascript-url.ts
*
* URL parsing ignores leading C0 control characters / spaces, and treats
* embedded tab/newline characters in the scheme as insignificant. We mirror
* that behavior here so obfuscated values like `java\nscript:` and
* `\x00javascript:` are still blocked.
*
* Vinext intentionally extends this handling to `data:` and `vbscript:` too,
* since both are also dangerous navigation targets.
*/
var LEADING_IGNORED = "[\\u0000-\\u001F \\u200B\\uFEFF]*";
var SCHEME_IGNORED = "[\\r\\n\\t]*";
function buildDangerousSchemeRegex(scheme) {
	const chars = scheme.split("").join(SCHEME_IGNORED);
	return new RegExp(`^${LEADING_IGNORED}${chars}${SCHEME_IGNORED}:`, "i");
}
buildDangerousSchemeRegex("javascript"), buildDangerousSchemeRegex("data"), buildDangerousSchemeRegex("vbscript");
[
	"RSC",
	"Accept",
	NEXT_ROUTER_STATE_TREE_HEADER,
	NEXT_ROUTER_PREFETCH_HEADER,
	NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
	NEXT_URL_HEADER,
	VINEXT_INTERCEPTION_CONTEXT_HEADER,
	VINEXT_MOUNTED_SLOTS_HEADER,
	VINEXT_RSC_RENDER_MODE_HEADER
].join(", ");
new TextEncoder();
//#endregion
//#region node_modules/vinext/dist/shims/readonly-url-search-params.js
var ReadonlyURLSearchParamsError = class extends Error {
	constructor() {
		super("Method unavailable on `ReadonlyURLSearchParams`. Read more: https://nextjs.org/docs/app/api-reference/functions/use-search-params#updating-searchparams");
	}
};
/**
* Read-only URLSearchParams wrapper matching Next.js runtime behavior.
* Mutation methods remain present for instanceof/API compatibility but throw.
*/
var ReadonlyURLSearchParams = class extends URLSearchParams {
	append(_name, _value) {
		throw new ReadonlyURLSearchParamsError();
	}
	delete(_name, _value) {
		throw new ReadonlyURLSearchParamsError();
	}
	set(_name, _value) {
		throw new ReadonlyURLSearchParamsError();
	}
	sort() {
		throw new ReadonlyURLSearchParamsError();
	}
};
//#endregion
//#region node_modules/vinext/dist/shims/navigation.js
var _SERVER_INSERTED_HTML_CTX_KEY = Symbol.for("vinext.serverInsertedHTMLContext");
function getServerInsertedHTMLContext() {
	if (typeof React$1.createContext !== "function") return null;
	const globalState = globalThis;
	if (!globalState[_SERVER_INSERTED_HTML_CTX_KEY]) globalState[_SERVER_INSERTED_HTML_CTX_KEY] = React$1.createContext(null);
	return globalState[_SERVER_INSERTED_HTML_CTX_KEY] ?? null;
}
getServerInsertedHTMLContext();
var GLOBAL_ACCESSORS_KEY = Symbol.for("vinext.navigation.globalAccessors");
/**
* Register ALS-backed state accessors. Called by navigation-state.ts on import.
* @internal
*/
function _registerStateAccessors(accessors) {
	accessors.getServerContext;
	accessors.setServerContext;
	accessors.getInsertedHTMLCallbacks;
	accessors.clearInsertedHTMLCallbacks;
}
var isServer = typeof window === "undefined";
var _CLIENT_NAV_STATE_KEY = Symbol.for("vinext.clientNavigationState");
function getClientNavigationState() {
	if (isServer) return null;
	const globalState = window;
	globalState[_CLIENT_NAV_STATE_KEY] ??= {
		listeners: /* @__PURE__ */ new Set(),
		cachedSearch: window.location.search,
		cachedReadonlySearchParams: new ReadonlyURLSearchParams(window.location.search),
		cachedPathname: stripBasePath(window.location.pathname, ""),
		clientParams: {},
		clientParamsJson: "{}",
		pendingClientParams: null,
		pendingClientParamsJson: null,
		pendingPathname: null,
		pendingPathnameNavId: null,
		originalPushState: window.history.pushState.bind(window.history),
		originalReplaceState: window.history.replaceState.bind(window.history),
		patchInstalled: false,
		hasPendingNavigationUpdate: false,
		suppressUrlNotifyCount: 0,
		navigationSnapshotActiveCount: 0
	};
	return globalState[_CLIENT_NAV_STATE_KEY];
}
function notifyNavigationListeners() {
	const state = getClientNavigationState();
	if (!state) return;
	for (const fn of state.listeners) fn();
}
function syncCommittedUrlStateFromLocation() {
	const state = getClientNavigationState();
	if (!state) return false;
	let changed = false;
	const pathname = stripBasePath(window.location.pathname, "");
	if (pathname !== state.cachedPathname) {
		state.cachedPathname = pathname;
		changed = true;
	}
	const search = window.location.search;
	if (search !== state.cachedSearch) {
		state.cachedSearch = search;
		state.cachedReadonlySearchParams = new ReadonlyURLSearchParams(search);
		changed = true;
	}
	return changed;
}
/**
* Commit pending client navigation state to committed snapshots.
*
* navId is optional: callers that don't own pendingPathname (for example,
* superseded pre-paint cleanup) may pass undefined to flush URL/params state
* without clearing pendingPathname owned by the active navigation. Such callers
* must opt in explicitly if they also own an activated render snapshot.
*/
function commitClientNavigationState(navId, options) {
	if (isServer) return;
	const state = getClientNavigationState();
	if (!state) return;
	if ((navId !== void 0 || options?.releaseSnapshot === true) && state.navigationSnapshotActiveCount > 0) state.navigationSnapshotActiveCount -= 1;
	const urlChanged = syncCommittedUrlStateFromLocation();
	if (state.pendingClientParams !== null && state.pendingClientParamsJson !== null) {
		state.clientParams = state.pendingClientParams;
		state.clientParamsJson = state.pendingClientParamsJson;
		state.pendingClientParams = null;
		state.pendingClientParamsJson = null;
	}
	if (state.pendingPathnameNavId === null || navId !== void 0 && state.pendingPathnameNavId === navId) {
		state.pendingPathname = null;
		state.pendingPathnameNavId = null;
	}
	const shouldNotify = urlChanged || state.hasPendingNavigationUpdate;
	state.hasPendingNavigationUpdate = false;
	if (shouldNotify) notifyNavigationListeners();
}
/**
* Restore scroll position from a history state object (used on popstate).
*
* When an RSC navigation is in flight (back/forward triggers both this
* handler and the browser entry's popstate handler which calls
* __VINEXT_RSC_NAVIGATE__), we must wait for the new content to render
* before scrolling. Otherwise the user sees old content flash at the
* restored scroll position.
*
* This handler fires before the browser entry's popstate handler (because
* navigation.ts is loaded before hydration completes), so we defer via a
* microtask to give the browser entry handler a chance to set
* __VINEXT_RSC_PENDING__. Promise.resolve() schedules a microtask
* that runs after all synchronous event listeners have completed.
*/
function restoreScrollPosition(state) {
	if (state && typeof state === "object" && "__vinext_scrollY" in state) {
		const { __vinext_scrollX: x, __vinext_scrollY: y } = state;
		Promise.resolve().then(() => {
			const pending = window.__VINEXT_RSC_PENDING__ ?? null;
			if (pending) pending.then(() => {
				requestAnimationFrame(() => {
					window.scrollTo(x, y);
				});
			});
			else requestAnimationFrame(() => {
				window.scrollTo(x, y);
			});
		});
	}
}
if (!isServer) {
	const state = getClientNavigationState();
	if (state && !state.patchInstalled) {
		state.patchInstalled = true;
		window.addEventListener("popstate", (event) => {
			if (typeof window.__VINEXT_RSC_NAVIGATE__ !== "function") {
				commitClientNavigationState();
				restoreScrollPosition(event.state);
			}
		});
		window.history.pushState = function patchedPushState(data, unused, url) {
			state.originalPushState.call(window.history, data, unused, url);
			if (state.suppressUrlNotifyCount === 0) commitClientNavigationState();
		};
		window.history.replaceState = function patchedReplaceState(data, unused, url) {
			state.originalReplaceState.call(window.history, data, unused, url);
			if (state.suppressUrlNotifyCount === 0) commitClientNavigationState();
		};
	}
}
//#endregion
//#region node_modules/vinext/dist/shims/navigation-state.js
/**
* Server-only navigation state backed by AsyncLocalStorage.
*
* This module provides request-scoped isolation for navigation context
* and useServerInsertedHTML callbacks. Without ALS, concurrent requests
* on Cloudflare Workers would share module-level state and leak data
* (pathnames, params, CSS-in-JS styles) between requests.
*
* This module is server-only — it imports node:async_hooks and must NOT
* be bundled for the browser. The dual-environment navigation.ts shim
* uses a registration pattern so it works in both environments.
*/
var _FALLBACK_KEY$2 = Symbol.for("vinext.navigation.fallback");
var _g$3 = globalThis;
var _als$2 = getOrCreateAls("vinext.navigation.als");
var _fallbackState$2 = _g$3[_FALLBACK_KEY$2] ??= {
	serverContext: null,
	serverInsertedHTMLCallbacks: []
};
function _getState$2() {
	if (isInsideUnifiedScope()) return getRequestContext();
	return _als$2.getStore() ?? _fallbackState$2;
}
function runWithServerInsertedHTMLState(fn) {
	if (isInsideUnifiedScope()) return runWithUnifiedStateMutation((uCtx) => {
		uCtx.serverInsertedHTMLCallbacks = [];
	}, fn);
	const state = {
		serverContext: (_als$2.getStore() ?? _fallbackState$2).serverContext,
		serverInsertedHTMLCallbacks: []
	};
	return _als$2.run(state, fn);
}
var _accessors = {
	getServerContext() {
		return _getState$2().serverContext;
	},
	setServerContext(ctx) {
		_getState$2().serverContext = ctx;
	},
	getInsertedHTMLCallbacks() {
		return _getState$2().serverInsertedHTMLCallbacks;
	},
	clearInsertedHTMLCallbacks() {
		_getState$2().serverInsertedHTMLCallbacks = [];
	}
};
_registerStateAccessors(_accessors);
globalThis[GLOBAL_ACCESSORS_KEY] = _accessors;
//#endregion
//#region node_modules/vinext/dist/shims/head-state.js
var _FALLBACK_KEY$1 = Symbol.for("vinext.head.fallback");
var _g$2 = globalThis;
var _als$1 = getOrCreateAls("vinext.head.als");
var _fallbackState$1 = _g$2[_FALLBACK_KEY$1] ??= { ssrHeadChildren: [] };
function _getState$1() {
	if (isInsideUnifiedScope()) return getRequestContext();
	return _als$1.getStore() ?? _fallbackState$1;
}
function runWithHeadState(fn) {
	if (isInsideUnifiedScope()) return runWithUnifiedStateMutation((uCtx) => {
		uCtx.ssrHeadChildren = [];
	}, fn);
	return _als$1.run({ ssrHeadChildren: [] }, fn);
}
_registerHeadStateAccessors({
	getSSRHeadChildren() {
		return _getState$1().ssrHeadChildren;
	},
	resetSSRHead() {
		_getState$1().ssrHeadChildren = [];
	}
});
/**
* Register ALS-backed accessors. Called by i18n-state.ts on import.
* @internal
*/
function _registerI18nStateAccessors(accessors) {
	accessors.getI18nContext;
	accessors.setI18nContext;
}
//#endregion
//#region node_modules/vinext/dist/shims/i18n-state.js
/**
* Server-only i18n state backed by AsyncLocalStorage.
*
* Provides request-scoped isolation for i18n context (locale,
* defaultLocale, domainLocales, hostname) so concurrent requests
* on Workers or Node.js don't share mutable locale state.
*
* This module is server-only — it imports node:async_hooks and must NOT
* be bundled for the browser.
*/
var _FALLBACK_KEY = Symbol.for("vinext.i18n.fallback");
var _g$1 = globalThis;
var _als = getOrCreateAls("vinext.i18n.als");
var _fallbackState = _g$1[_FALLBACK_KEY] ??= { i18nContext: null };
function _getState() {
	if (isInsideUnifiedScope()) return getRequestContext();
	return _als.getStore() ?? _fallbackState;
}
_registerI18nStateAccessors({
	getI18nContext() {
		return _getState().i18nContext;
	},
	setI18nContext(ctx) {
		_getState().i18nContext = ctx;
	}
});
//#endregion
//#region node_modules/vinext/dist/server/html.js
/**
* HTML-safe JSON serialization for embedding data in <script> tags.
*
* JSON.stringify does NOT escape characters that are meaningful to the
* HTML parser. If a JSON string value contains "<\/script>", the browser
* closes the script tag early — anything after it executes as HTML.
* This is a well-known stored XSS vector in SSR frameworks.
*
* Next.js mitigates this with htmlEscapeJsonString(). We do the same.
*
* Characters escaped:
*   <   → \u003c   (prevents <\/script> and <!-- breakout)
*   >   → \u003e   (prevents --> and other HTML close sequences)
*   &   → \u0026   (prevents &lt; entity interpretation in XHTML)
*   \u2028 → \\u2028 (line separator — invalid in JS string literals pre-ES2019)
*   \u2029 → \\u2029 (paragraph separator — same)
*
* The result is valid JSON that is also safe to embed in any HTML context
* without additional escaping.
*/
function safeJsonStringify(data) {
	return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function escapeHtmlAttr(value) {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function createNonceAttribute(nonce) {
	if (!nonce) return "";
	return ` nonce="${escapeHtmlAttr(nonce)}"`;
}
function createInlineScriptTag(content, nonce) {
	return `<script${createNonceAttribute(nonce)}>${content}<\/script>`;
}
//#endregion
//#region node_modules/vinext/dist/build/google-fonts/sort-variants.js
function sortFontsVariantValues(valA, valB) {
	if (valA.includes(",") && valB.includes(",")) {
		const [aPrefix, aSuffix] = valA.split(",", 2);
		const [bPrefix, bSuffix] = valB.split(",", 2);
		if (aPrefix === bPrefix) return parseInt(aSuffix) - parseInt(bSuffix);
		return parseInt(aPrefix) - parseInt(bPrefix);
	}
	return parseInt(valA) - parseInt(valB);
}
//#endregion
//#region node_modules/vinext/dist/build/google-fonts/build-url.js
function buildGoogleFontsUrl$1(fontFamily, axes, display) {
	const variants = [];
	if (axes.wght) for (const wght of axes.wght) if (!axes.ital) variants.push([["wght", wght], ...axes.variableAxes ?? []]);
	else for (const ital of axes.ital) variants.push([
		["ital", ital],
		["wght", wght],
		...axes.variableAxes ?? []
	]);
	else if (axes.variableAxes) variants.push([...axes.variableAxes]);
	if (axes.variableAxes) for (const variant of variants) variant.sort(([a], [b]) => {
		const aIsLowercase = a.charCodeAt(0) > 96;
		const bIsLowercase = b.charCodeAt(0) > 96;
		if (aIsLowercase && !bIsLowercase) return -1;
		if (bIsLowercase && !aIsLowercase) return 1;
		return a > b ? 1 : -1;
	});
	let url = `https://fonts.googleapis.com/css2?family=${fontFamily.replace(/ /g, "+")}`;
	if (variants.length > 0) {
		const keyList = variants[0].map(([key]) => key).join(",");
		const valueLists = variants.map((variant) => variant.map(([, val]) => val).join(",")).sort(sortFontsVariantValues).join(";");
		url = `${url}:${keyList}@${valueLists}`;
	}
	return `${url}&display=${display}`;
}
//#endregion
//#region node_modules/vinext/dist/shims/font-google-base.js
/**
* next/font/google shim
*
* Provides a compatible shim for Next.js Google Fonts.
*
* Two modes:
* 1. **Dev / CDN mode** (default): Loads fonts from Google Fonts CDN via <link> tags.
* 2. **Self-hosted mode** (production build): The vinext:google-fonts Vite plugin
*    fetches font CSS + .woff2 files at build time, caches them locally, and injects
*    @font-face CSS pointing at local assets. No requests to Google at runtime.
*
* Usage:
*   import { Inter } from 'next/font/google';
*   const inter = Inter({ subsets: ['latin'], weight: ['400', '700'] });
*   // inter.className -> stable CSS class for this font/options pair
*   // inter.style -> { fontFamily: "'Inter', sans-serif" }
*   // inter.variable -> CSS class that sets the font CSS variable
*/
/**
* Escape a string for safe interpolation inside a CSS single-quoted string.
*
* Prevents CSS injection by escaping characters that could break out of
* a `'...'` CSS string context: backslashes, single quotes, and newlines.
*/
function escapeCSSString(value) {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ");
}
/**
* Validate a CSS custom property name (e.g. `--font-inter`).
*
* Custom properties must start with `--` and only contain alphanumeric
* characters, hyphens, and underscores. Anything else could be used to
* break out of the CSS declaration and inject arbitrary rules.
*
* Returns the name if valid, undefined otherwise.
*/
function sanitizeCSSVarName(name) {
	if (/^--[a-zA-Z0-9_-]+$/.test(name)) return name;
}
/**
* Sanitize a CSS font-family fallback name.
*
* Generic family names (sans-serif, serif, monospace, etc.) are used as-is.
* Named families are wrapped in escaped quotes. This prevents injection via
* crafted fallback values like `); } body { color: red; } .x {`.
*/
function sanitizeFallback(name) {
	const generics = new Set([
		"serif",
		"sans-serif",
		"monospace",
		"cursive",
		"fantasy",
		"system-ui",
		"ui-serif",
		"ui-sans-serif",
		"ui-monospace",
		"ui-rounded",
		"emoji",
		"math",
		"fangsong"
	]);
	const trimmed = name.trim();
	if (generics.has(trimmed)) return trimmed;
	return `'${escapeCSSString(trimmed)}'`;
}
var injectedFonts = /* @__PURE__ */ new Set();
/**
* Convert a font family name to a CSS variable name.
* e.g., "Inter" -> "--font-inter", "Roboto Mono" -> "--font-roboto-mono"
*/
function toVarName(family) {
	return "--font-" + family.toLowerCase().replace(/\s+/g, "-");
}
function fontClassSegment(family) {
	return family.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "font";
}
function normalizeStringSetOption(value) {
	if (!value) return "";
	return [...new Set((Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean))].sort().join(",");
}
function normalizeWeightOption(value) {
	const normalized = normalizeStringSetOption(value);
	return normalized === "variable" ? "" : normalized;
}
function normalizeStyleOption(value) {
	const values = new Set((Array.isArray(value) ? value : value ? [value] : []).map((item) => item.trim()).filter(Boolean));
	const hasItalic = values.has("italic");
	const hasNormal = values.has("normal");
	if (!hasItalic) return "";
	return hasNormal ? "italic,normal" : "italic";
}
function normalizeFallbackOption(value) {
	if (!value) return "";
	return value.map((item) => item.trim()).join(",");
}
function normalizeBooleanOption(value) {
	if (value === void 0) return "";
	return value ? "1" : "0";
}
function normalizeStringOrBooleanOption(value) {
	if (value === void 0) return "";
	return typeof value === "boolean" ? normalizeBooleanOption(value) : value;
}
function hashString(value) {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(36).padStart(7, "0");
}
function createFontIdentity(family, options, cssVarName, fallback) {
	return hashString([
		family,
		cssVarName,
		normalizeWeightOption(options.weight),
		normalizeStyleOption(options.style),
		normalizeStringSetOption(options.subsets),
		options.display ?? "swap",
		normalizeBooleanOption(options.preload),
		normalizeFallbackOption(fallback),
		normalizeStringOrBooleanOption(options.adjustFontFallback),
		normalizeStringSetOption(options.axes),
		options._selfHostedCSS ?? ""
	].join("\0"));
}
/**
* Build a Google Fonts CSS URL.
*
* In production this code path is dead. The build plugin
* (`vinext:google-fonts` in `src/plugins/fonts.ts`) statically resolves
* each font call's axis values against the bundled metadata, fetches the
* Google Fonts CSS, and injects the resulting CSS as `_selfHostedCSS` so
* the runtime never queries Google. The shim only reaches this builder
* when the plugin's static parser bails (dynamic options, eval-only
* shapes), which is dev-only.
*
* The dev fallback intentionally has no metadata: shipping the 388 KB
* `font-data.json` to the Worker bundle would dwarf the rest of the shim,
* and the production path already has the metadata-aware variant. The
* tradeoff is that the dev fallback cannot resolve a variable font's
* actual `wght` axis range. It emits no axis segment when no `weight` is
* given, which makes Google return the default static face (200) instead
* of the broken `:wght@100..900` URL that issue #885 reports.
*/
function buildGoogleFontsUrl(family, options) {
	const weights = options.weight ? Array.isArray(options.weight) ? options.weight : [options.weight] : [];
	const styles = options.style ? Array.isArray(options.style) ? options.style : [options.style] : [];
	const hasItalic = styles.includes("italic");
	const hasNormal = styles.includes("normal");
	const ital = hasItalic ? [...hasNormal ? ["0"] : [], "1"] : void 0;
	const normalizedWeights = weights.length === 1 && weights[0] === "variable" ? [] : weights;
	return buildGoogleFontsUrl$1(family, {
		wght: normalizedWeights.length > 0 ? normalizedWeights : ital ? ["400"] : void 0,
		ital
	}, options.display ?? "swap");
}
/**
* Inject a <link> tag for the font (client-side only).
* On the server, we track font URLs for SSR head injection.
*/
function injectFontStylesheet(url) {
	if (injectedFonts.has(url)) return;
	injectedFonts.add(url);
	if (typeof document !== "undefined") {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		document.head.appendChild(link);
	}
}
/** Track which className CSS rules have been injected. */
var injectedClassRules = /* @__PURE__ */ new Set();
/**
* Inject a CSS rule that maps a className to a font-family.
*
* This is what makes `<div className={inter.className}>` apply the font.
* Next.js generates equivalent rules at build time.
*
* In Next.js, the .className class ONLY sets font-family — it does NOT
* set CSS variables. CSS variables are handled separately by the .variable class.
*/
function injectClassNameRule(className, fontFamily) {
	if (injectedClassRules.has(className)) return;
	injectedClassRules.add(className);
	const css = `.${className} { font-family: ${fontFamily}; }\n`;
	if (typeof document === "undefined") {
		ssrFontStyles$1.push(css);
		return;
	}
	const style = document.createElement("style");
	style.textContent = css;
	style.setAttribute("data-vinext-font-class", className);
	document.head.appendChild(style);
}
/** Track which variable class CSS rules have been injected. */
var injectedVariableRules = /* @__PURE__ */ new Set();
/**
* Inject a CSS rule that sets a CSS variable on an element.
* This is what makes `<html className={inter.variable}>` set the CSS variable
* that can be referenced by other styles (e.g., Tailwind's font-sans).
*
* In Next.js, the .variable class ONLY sets the CSS variable — it does NOT
* set font-family. This is critical because apps commonly apply multiple
* .variable classes to <body> (e.g., geistSans.variable + geistMono.variable).
* If we also set font-family here, the last class wins due to CSS cascade,
* causing all text to use that font (e.g., everything becomes monospace).
*/
function injectVariableClassRule(variableClassName, cssVarName, fontFamily) {
	if (injectedVariableRules.has(variableClassName)) return;
	injectedVariableRules.add(variableClassName);
	const css = `.${variableClassName} { ${cssVarName}: ${fontFamily}; }\n`;
	if (typeof document === "undefined") {
		ssrFontStyles$1.push(css);
		return;
	}
	const style = document.createElement("style");
	style.textContent = css;
	style.setAttribute("data-vinext-font-variable", variableClassName);
	document.head.appendChild(style);
}
var ssrFontStyles$1 = [];
/**
* Get collected SSR font class styles (used by the renderer).
* Note: We don't clear the arrays because fonts are loaded at module import
* time and need to persist across all requests in the Workers environment.
*/
function getSSRFontStyles$1() {
	return [...ssrFontStyles$1];
}
var ssrFontUrls = [];
/**
* Get collected SSR font URLs (used by the renderer).
* Note: We don't clear the arrays because fonts are loaded at module import
* time and need to persist across all requests in the Workers environment.
*/
function getSSRFontLinks() {
	return [...ssrFontUrls];
}
var ssrFontPreloads$1 = [];
var ssrFontPreloadHrefs = /* @__PURE__ */ new Set();
/**
* Get collected SSR font preload data (used by the renderer).
* Returns an array of { href, type } objects for emitting
* <link rel="preload" as="font" ...> tags.
*/
function getSSRFontPreloads$1() {
	return [...ssrFontPreloads$1];
}
/**
* Determine the MIME type for a font file based on its extension.
*/
function getFontMimeType(pathOrUrl) {
	if (pathOrUrl.endsWith(".woff2")) return "font/woff2";
	if (pathOrUrl.endsWith(".woff")) return "font/woff";
	if (pathOrUrl.endsWith(".ttf")) return "font/ttf";
	if (pathOrUrl.endsWith(".otf")) return "font/opentype";
	return "font/woff2";
}
/**
* Extract font file URLs from @font-face CSS rules.
* Parses url('...') references from the CSS text.
*/
function extractFontUrlsFromCSS(css) {
	const urls = [];
	const urlRegex = /url\(['"]?([^'")]+)['"]?\)/g;
	let match;
	while ((match = urlRegex.exec(css)) !== null) {
		const url = match[1];
		if (url && url.startsWith("/")) urls.push(url);
	}
	return urls;
}
/**
* Collect font file URLs from self-hosted CSS for preload link generation.
* Only collects on the server (SSR). Deduplicates by href using a Set for O(1) lookups.
*/
function collectFontPreloadsFromCSS(css) {
	if (typeof document !== "undefined") return;
	const urls = extractFontUrlsFromCSS(css);
	for (const href of urls) if (!ssrFontPreloadHrefs.has(href)) {
		ssrFontPreloadHrefs.add(href);
		ssrFontPreloads$1.push({
			href,
			type: getFontMimeType(href)
		});
	}
}
/** Track injected self-hosted @font-face blocks (deduplicate) */
var injectedSelfHosted = /* @__PURE__ */ new Set();
/**
* Inject self-hosted @font-face CSS (from the build plugin).
* This replaces the CDN <link> tag with inline CSS.
*/
function injectSelfHostedCSS(css) {
	if (injectedSelfHosted.has(css)) return;
	injectedSelfHosted.add(css);
	collectFontPreloadsFromCSS(css);
	if (typeof document === "undefined") {
		ssrFontStyles$1.push(css);
		return;
	}
	const style = document.createElement("style");
	style.textContent = css;
	style.setAttribute("data-vinext-font-selfhosted", "true");
	document.head.appendChild(style);
}
function createFontLoader(family) {
	return function fontLoader(options = {}) {
		const fallback = options.fallback ?? ["sans-serif"];
		const fontFamily = `'${escapeCSSString(family)}', ${fallback.map(sanitizeFallback).join(", ")}`;
		const defaultVarName = toVarName(family);
		const cssVarName = options.variable ? sanitizeCSSVarName(options.variable) ?? defaultVarName : defaultVarName;
		const id = createFontIdentity(family, options, cssVarName, fallback);
		const classSegment = fontClassSegment(family);
		const className = `__font_${classSegment}_${id}`;
		const variableClassName = `__variable_${classSegment}_${id}`;
		if (options._selfHostedCSS) injectSelfHostedCSS(options._selfHostedCSS);
		else {
			const url = buildGoogleFontsUrl(family, options);
			injectFontStylesheet(url);
			if (typeof document === "undefined") {
				if (!ssrFontUrls.includes(url)) ssrFontUrls.push(url);
			}
		}
		injectClassNameRule(className, fontFamily);
		injectVariableClassRule(variableClassName, cssVarName, fontFamily);
		return {
			className,
			style: { fontFamily },
			variable: variableClassName
		};
	};
}
var googleFonts = new Proxy({}, { get(_target, prop) {
	if (typeof prop !== "string") return void 0;
	if (prop === "__esModule") return true;
	if (prop === "default") return googleFonts;
	return createFontLoader(prop.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));
} });
//#endregion
//#region node_modules/vinext/dist/shims/font-local.js
var ssrFontStyles = [];
var ssrFontPreloads = [];
/**
* Get collected SSR font styles (used by the renderer).
* Note: We don't clear the arrays because fonts are loaded at module import
* time and need to persist across all requests in the Workers environment.
*/
function getSSRFontStyles() {
	return [...ssrFontStyles];
}
/**
* Get collected SSR font preload data (used by the renderer).
* Returns an array of { href, type } objects for emitting
* <link rel="preload" as="font" ...> tags.
*/
function getSSRFontPreloads() {
	return [...ssrFontPreloads];
}
//#endregion
//#region node_modules/vinext/dist/config/config-matchers.js
/**
* Parse a Cookie header string into a key-value record.
*/
function parseCookies(cookieHeader) {
	if (!cookieHeader) return {};
	const cookies = {};
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (key) cookies[key] = value;
	}
	return cookies;
}
/**
* Sanitize a redirect/rewrite destination to collapse protocol-relative URLs.
*
* After parameter substitution, a destination like `/:path*` can become
* `//evil.com` if the catch-all captured a decoded `%2F` (`/evil.com`).
* Browsers interpret `//evil.com` as a protocol-relative URL, redirecting
* users off-site.
*
* This function collapses any leading double (or more) slashes to a single
* slash for non-external (relative) destinations.
*/
function sanitizeDestination(dest) {
	if (dest.startsWith("http://") || dest.startsWith("https://")) return dest;
	dest = dest.replace(/^[\\/]+/, "/");
	return dest;
}
//#endregion
//#region node_modules/vinext/dist/routing/utils.js
function decodeMatchedParam(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
/**
* Decode captured route params with `decodeURIComponent`, mirroring Next.js
* route-matcher.ts:25-27. Mutates the params object in place. Catch-all
* arrays are decoded element-wise. Malformed escapes are preserved (the
* strict normalization layer rejects them at the request boundary).
*/
function decodeMatchedParams(params) {
	for (const key of Object.keys(params)) {
		const value = params[key];
		if (Array.isArray(value)) params[key] = value.map(decodeMatchedParam);
		else params[key] = decodeMatchedParam(value);
	}
}
globalThis.URLPattern;
new Headers(), new URLSearchParams();
//#endregion
//#region node_modules/vinext/dist/server/http-error-responses.js
/**
* Build a 500 Internal Server Error plain-text response.
*
* The `message` argument lets dev-mode handlers surface failure details while
* production paths fall back to the canonical body. Pass `undefined` (or omit)
* to use the canonical "Internal Server Error" body.
*/
function internalServerErrorResponse(message, init) {
	return new Response(message ?? "Internal Server Error", {
		status: 500,
		headers: init?.headers
	});
}
//#endregion
//#region node_modules/vinext/dist/routing/route-trie.js
function createNode() {
	return {
		staticChildren: /* @__PURE__ */ new Map(),
		dynamicChild: null,
		catchAllChild: null,
		optionalCatchAllChild: null,
		route: null
	};
}
/**
* Build a trie from pre-sorted routes.
*
* Routes must have a `patternParts` property (string[] of URL segments).
* Pattern segment conventions:
*   - `:name`  — dynamic segment
*   - `:name+` — catch-all (1+ segments)
*   - `:name*` — optional catch-all (0+ segments)
*   - anything else — static segment
*
* First route to claim a terminal position wins (routes are pre-sorted
* by precedence, so insertion order preserves correct priority).
*/
function buildRouteTrie(routes) {
	const root = createNode();
	for (const route of routes) {
		const parts = route.patternParts;
		if (parts.length === 0) {
			if (root.route === null) root.route = route;
			continue;
		}
		let node = root;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (part.endsWith("+") && part.startsWith(":")) {
				if (i !== parts.length - 1) break;
				const paramName = part.slice(1, -1);
				if (node.catchAllChild === null) node.catchAllChild = {
					paramName,
					route
				};
				break;
			}
			if (part.endsWith("*") && part.startsWith(":")) {
				if (i !== parts.length - 1) break;
				const paramName = part.slice(1, -1);
				if (node.optionalCatchAllChild === null) node.optionalCatchAllChild = {
					paramName,
					route
				};
				break;
			}
			if (part.startsWith(":")) {
				const paramName = part.slice(1);
				if (node.dynamicChild === null) node.dynamicChild = {
					paramName,
					node: createNode()
				};
				node = node.dynamicChild.node;
				if (i === parts.length - 1) {
					if (node.route === null) node.route = route;
				}
				continue;
			}
			let child = node.staticChildren.get(part);
			if (!child) {
				child = createNode();
				node.staticChildren.set(part, child);
			}
			node = child;
			if (i === parts.length - 1) {
				if (node.route === null) node.route = route;
			}
		}
	}
	return root;
}
/**
* Match a URL against the trie.
*
* Returns decoded param values — `decodeURIComponent` is applied to
* individual param entries so that `%2F` → `/`, `%23` → `#`, etc.
* Segment boundaries (the original `/` splits) are preserved by the
* upstream normalization layer; this step only decodes the captured
* param strings the caller sees.
*
* Mirrors Next.js route-matcher.ts:25-27.
*
* @param root - Trie root built by `buildRouteTrie`
* @param urlParts - Pre-split URL segments (no empty strings)
* @returns Match result with route and extracted params, or null
*/
function trieMatch(root, urlParts) {
	const result = match(root, urlParts, 0);
	if (result) decodeMatchedParams(result.params);
	return result;
}
function createParams() {
	return Object.create(null);
}
function match(node, urlParts, index) {
	if (index === urlParts.length) {
		if (node.route !== null) return {
			route: node.route,
			params: createParams()
		};
		if (node.optionalCatchAllChild !== null) return {
			route: node.optionalCatchAllChild.route,
			params: createParams()
		};
		return null;
	}
	const segment = urlParts[index];
	const staticChild = node.staticChildren.get(segment);
	if (staticChild) {
		const result = match(staticChild, urlParts, index + 1);
		if (result !== null) return result;
	}
	if (node.dynamicChild !== null) {
		const result = match(node.dynamicChild.node, urlParts, index + 1);
		if (result !== null) {
			result.params[node.dynamicChild.paramName] = segment;
			return result;
		}
	}
	if (node.catchAllChild !== null) {
		const remaining = urlParts.slice(index);
		const params = createParams();
		params[node.catchAllChild.paramName] = remaining;
		return {
			route: node.catchAllChild.route,
			params
		};
	}
	if (node.optionalCatchAllChild !== null) {
		const remaining = urlParts.slice(index);
		const params = createParams();
		params[node.optionalCatchAllChild.paramName] = remaining;
		return {
			route: node.optionalCatchAllChild.route,
			params
		};
	}
	return null;
}
//#endregion
//#region node_modules/vinext/dist/server/instrumentation.js
/**
* Get the registered onRequestError handler (if any).
*
* Reads from globalThis so it works across Vite environment boundaries.
*/
function getOnRequestErrorHandler() {
	return globalThis.__VINEXT_onRequestErrorHandler__ ?? null;
}
/**
* Report a request error via the instrumentation handler.
*
* No-op if no onRequestError handler is registered.
*
* Reads the handler from globalThis so this function works correctly regardless
* of which environment it is called from.
*/
function reportRequestError(error, request, context) {
	const handler = getOnRequestErrorHandler();
	if (!handler) return Promise.resolve();
	const promise = (async () => {
		try {
			await handler(error, request, context);
		} catch (reportErr) {
			console.error("[vinext] onRequestError handler threw:", reportErr instanceof Error ? reportErr.message : String(reportErr));
		}
	})();
	getRequestExecutionContext()?.waitUntil(promise);
	return promise;
}
//#endregion
//#region node_modules/vinext/dist/server/pages-media-type.js
/**
* Shared media-type helpers and body-parse error for Pages API routes.
*
* Used by both api-handler.ts (Pages Router dev/prod with Node.js req/res) and
* pages-node-compat.ts (Pages Router fetch-based facade for Cloudflare Workers).
*/
var PagesBodyParseError = class extends Error {
	constructor(message, statusCode) {
		super(message);
		this.statusCode = statusCode;
		this.name = "PagesBodyParseError";
	}
};
function getMediaType(contentType) {
	const [type] = (contentType ?? "text/plain").split(";");
	return type?.trim().toLowerCase() || "text/plain";
}
function isJsonMediaType(mediaType) {
	return mediaType === "application/json" || mediaType === "application/ld+json";
}
//#endregion
//#region node_modules/vinext/dist/utils/text-stream.js
/**
* Helpers for the repeated `new TextDecoder()` + `ReadableStream` chunk-loop
* pattern used across the server. Each helper handles the streaming-decode
* boundary correctly (final empty `decoder.decode()` flush so any incomplete
* trailing UTF-8 sequence is reported).
*
* Sites with additional load-bearing behaviour (line-buffered transforms,
* raw-byte accumulators, mixed string/Uint8Array streams, cache-key body
* canonicalisation) intentionally still inline their own decoder.
*/
/**
* Drain a UTF-8 byte stream and return the full decoded text. The stream
* reader is released on both success and failure.
*/
async function readStreamAsText(stream) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}
/**
* Drain a UTF-8 byte stream up to `maxBytes` of *raw* input, returning the
* decoded text. If the raw size limit is exceeded, the reader is cancelled
* and `onLimitExceeded` is invoked; it MUST throw — its return type is
* `never` to enforce that. Each caller passes its own error type.
*
* The size check is on raw bytes (pre-decode) to bound memory before
* paying the decoder cost.
*/
async function readStreamAsTextWithLimit(stream, maxBytes, onLimitExceeded) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks = [];
	let totalSize = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			totalSize += result.value.byteLength;
			if (totalSize > maxBytes) {
				await reader.cancel();
				onLimitExceeded();
			}
			chunks.push(decoder.decode(result.value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}
//#endregion
//#region node_modules/vinext/dist/server/pages-node-compat.js
var MAX_PAGES_API_BODY_SIZE = 1 * 1024 * 1024;
async function readPagesRequestBodyWithLimit(request, maxBytes) {
	if (!request.body) return "";
	return readStreamAsTextWithLimit(request.body, maxBytes, () => {
		throw new PagesBodyParseError("Request body too large", 413);
	});
}
async function parsePagesApiBody(request, maxBytes = MAX_PAGES_API_BODY_SIZE) {
	if (Number.parseInt(request.headers.get("content-length") || "0", 10) > maxBytes) throw new PagesBodyParseError("Request body too large", 413);
	let rawBody = "";
	try {
		rawBody = await readPagesRequestBodyWithLimit(request, maxBytes);
	} catch (err) {
		if (err instanceof PagesBodyParseError) throw err;
		throw new PagesBodyParseError("Request body too large", 413);
	}
	const mediaType = getMediaType(request.headers.get("content-type"));
	if (!rawBody) return isJsonMediaType(mediaType) ? {} : mediaType === "application/x-www-form-urlencoded" ? decode(rawBody) : void 0;
	if (isJsonMediaType(mediaType)) try {
		return JSON.parse(rawBody);
	} catch {
		throw new PagesBodyParseError("Invalid JSON", 400);
	}
	if (mediaType === "application/x-www-form-urlencoded") return decode(rawBody);
	return rawBody;
}
function createPagesReqRes(options) {
	const headersObj = {};
	for (const [key, value] of options.request.headers) headersObj[key.toLowerCase()] = value;
	const req = {
		method: options.request.method,
		url: options.url,
		headers: headersObj,
		query: options.query,
		body: options.body,
		cookies: parseCookies(options.request.headers.get("cookie"))
	};
	let resStatusCode = 200;
	const resHeaders = {};
	const setCookieHeaders = [];
	let resBody = null;
	let ended = false;
	let resolveResponse;
	const responsePromise = new Promise((resolve) => {
		resolveResponse = resolve;
	});
	const res = {
		get statusCode() {
			return resStatusCode;
		},
		set statusCode(code) {
			resStatusCode = code;
		},
		get headersSent() {
			return ended;
		},
		writeHead(code, headers) {
			resStatusCode = code;
			if (headers) for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === "set-cookie") if (Array.isArray(value)) setCookieHeaders.push(...value.map(String));
			else setCookieHeaders.push(String(value));
			else resHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
			return res;
		},
		setHeader(name, value) {
			if (name.toLowerCase() === "set-cookie") {
				setCookieHeaders.length = 0;
				if (Array.isArray(value)) setCookieHeaders.push(...value.map(String));
				else setCookieHeaders.push(String(value));
			} else resHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
			return res;
		},
		getHeader(name) {
			if (name.toLowerCase() === "set-cookie") return setCookieHeaders.length > 0 ? setCookieHeaders : void 0;
			return resHeaders[name.toLowerCase()];
		},
		end(data) {
			if (ended) return;
			ended = true;
			if (data !== void 0 && data !== null) resBody = data;
			const headers = new Headers();
			for (const [key, value] of Object.entries(resHeaders)) headers.set(key, String(value));
			for (const cookie of setCookieHeaders) headers.append("set-cookie", cookie);
			resolveResponse(new Response(resBody, {
				status: resStatusCode,
				headers
			}));
		},
		status(code) {
			resStatusCode = code;
			return res;
		},
		json(data) {
			resHeaders["content-type"] = "application/json";
			res.end(JSON.stringify(data));
		},
		send(data) {
			if (Buffer.isBuffer(data)) {
				if (!resHeaders["content-type"]) resHeaders["content-type"] = "application/octet-stream";
				resHeaders["content-length"] = String(data.length);
				res.end(new Uint8Array(data));
				return;
			}
			if (typeof data === "object" && data !== null) {
				resHeaders["content-type"] = "application/json";
				res.end(JSON.stringify(data));
				return;
			}
			if (!resHeaders["content-type"]) resHeaders["content-type"] = "text/plain";
			res.end(String(data));
		},
		redirect(statusOrUrl, url) {
			if (typeof statusOrUrl === "string") res.writeHead(307, { Location: statusOrUrl });
			else res.writeHead(statusOrUrl, { Location: url ?? "" });
			res.end();
		},
		getHeaders() {
			const headers = { ...resHeaders };
			if (setCookieHeaders.length > 0) headers["set-cookie"] = setCookieHeaders;
			return headers;
		}
	};
	return {
		req,
		res,
		responsePromise
	};
}
//#endregion
//#region node_modules/vinext/dist/server/pages-api-route.js
function buildPagesApiQuery(url, params) {
	return mergeRouteParamsIntoQuery$1(parseQueryString(url), params);
}
async function handlePagesApiRoute(options) {
	if (!options.match) return new Response("404 - API route not found", { status: 404 });
	const { route, params } = options.match;
	const handler = route.module.default;
	if (typeof handler !== "function") return new Response("API route does not export a default function", { status: 500 });
	try {
		const query = buildPagesApiQuery(options.url, params);
		const { req, res, responsePromise } = createPagesReqRes({
			body: await parsePagesApiBody(options.request),
			query,
			request: options.request,
			url: options.url
		});
		await handler(req, res);
		res.end();
		return await responsePromise;
	} catch (error) {
		if (error instanceof PagesBodyParseError) return new Response(error.message, {
			status: error.statusCode,
			statusText: error.message
		});
		options.reportRequestError?.(error instanceof Error ? error : new Error(String(error)), route.pattern);
		return internalServerErrorResponse();
	}
}
//#endregion
//#region node_modules/vinext/dist/server/isr-cache.js
/**
* ISR (Incremental Static Regeneration) cache layer.
*
* Wraps the pluggable CacheHandler with stale-while-revalidate semantics:
* - Fresh hit: serve immediately
* - Stale hit: serve immediately + trigger background regeneration
* - Miss: render synchronously, cache, serve
*
* Background regeneration is deduped — only one regeneration per cache key
* runs at a time, preventing thundering herd on popular pages.
*
* This layer works with any CacheHandler backend (memory, Redis, KV, etc.)
* because it only uses the standard get/set interface.
*/
/**
* Get a cache entry with staleness information.
*
* Returns { value, isStale: false } for fresh entries,
* { value, isStale: true } for expired-but-usable entries,
* or null for cache misses.
*/
async function isrGet$1(key) {
	const result = await getCacheHandler().get(key);
	if (!result || !result.value) return null;
	if (result.cacheState === "expired") return null;
	return {
		value: result,
		isStale: result.cacheState === "stale"
	};
}
/**
* Store a value in the ISR cache with a revalidation period.
*/
async function isrSet$1(key, data, revalidateSeconds, tags, expireSeconds) {
	await getCacheHandler().set(key, data, {
		cacheControl: expireSeconds === void 0 ? { revalidate: revalidateSeconds } : {
			revalidate: revalidateSeconds,
			expire: expireSeconds
		},
		revalidate: revalidateSeconds,
		tags: tags ?? []
	});
}
var _PENDING_REGEN_KEY = Symbol.for("vinext.isrCache.pendingRegenerations");
var _g = globalThis;
var pendingRegenerations = _g[_PENDING_REGEN_KEY] ??= /* @__PURE__ */ new Map();
/**
* Trigger a background regeneration for a cache key.
*
* If a regeneration for this key is already in progress, this is a no-op.
* The renderFn should produce the new cache value and call isrSet internally.
*
* On Cloudflare Workers the regeneration promise is registered with
* `ctx.waitUntil()` via the ALS-backed ExecutionContext, keeping the isolate
* alive until the regeneration completes even after the Response is returned.
*
* When `errorContext` is provided and the render function fails, the error
* is reported via `reportRequestError` (instrumentation hook) with
* `revalidateReason: "stale"`.
*/
function triggerBackgroundRegeneration$1(key, renderFn, errorContext) {
	if (pendingRegenerations.has(key)) return;
	const promise = renderFn().catch((err) => {
		console.error(`[vinext] ISR background regeneration failed for ${key}:`, err);
		if (errorContext) reportRequestError(err instanceof Error ? err : new Error(String(err)), {
			path: key,
			method: "GET",
			headers: {}
		}, {
			routerKind: errorContext.routerKind,
			routePath: errorContext.routePath,
			routeType: errorContext.routeType,
			revalidateReason: "stale"
		});
	}).finally(() => {
		pendingRegenerations.delete(key);
	});
	pendingRegenerations.set(key, promise);
	getRequestExecutionContext()?.waitUntil(promise);
}
/**
* Build a CachedPagesValue for the Pages Router ISR cache.
*/
function buildPagesCacheValue(html, pageData, status) {
	return {
		kind: "PAGES",
		html,
		pageData,
		headers: void 0,
		status
	};
}
function normalizeCachePathname(pathname) {
	return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}
function buildCacheKey(prefix, pathname, suffix) {
	const normalized = normalizeCachePathname(pathname);
	const suffixPart = suffix ? `:${suffix}` : "";
	const key = `${prefix}:${normalized}${suffixPart}`;
	if (key.length <= 200) return key;
	return `${prefix}:__hash:${fnv1a64(normalized)}${suffixPart}`;
}
/**
* Compute an ISR cache key for a given router type and pathname.
* Long pathnames are hashed to stay within KV key-length limits (512 bytes).
*/
function isrCacheKey$1(router, pathname, buildId) {
	return buildCacheKey(buildId ? `${router}:${buildId}` : router, pathname);
}
var _REVALIDATE_KEY = Symbol.for("vinext.isrCache.revalidateDurations");
_g[_REVALIDATE_KEY] ??= /* @__PURE__ */ new Map();
//#endregion
//#region node_modules/vinext/dist/server/csp.js
var ESCAPE_REGEX = /[&><\u2028\u2029]/;
function matchesDirectiveName(directive, name) {
	return directive === name || directive.startsWith(`${name} `);
}
function getScriptNonceFromHeader(cspHeaderValue) {
	const directives = cspHeaderValue.split(";").map((directive) => directive.trim());
	const directive = directives.find((value) => matchesDirectiveName(value, "script-src")) ?? directives.find((value) => matchesDirectiveName(value, "default-src"));
	if (!directive) return;
	const nonce = directive.split(" ").slice(1).map((source) => source.trim()).find((source) => source.startsWith("'nonce-") && source.length > 8 && source.endsWith("'"))?.slice(7, -1);
	if (!nonce) return;
	if (ESCAPE_REGEX.test(nonce)) throw new Error("Nonce value from Content-Security-Policy contained HTML escape characters.\nLearn more: https://nextjs.org/docs/messages/nonce-contained-invalid-characters");
	return nonce;
}
function getScriptNonceFromHeaders(headers) {
	const csp = headers?.get("content-security-policy") ?? headers?.get("content-security-policy-report-only");
	if (!csp) return;
	return getScriptNonceFromHeader(csp);
}
function getScriptNonceFromHeaderSources(...headersList) {
	for (const headers of headersList) {
		const nonce = getScriptNonceFromHeaders(headers);
		if (nonce) return nonce;
	}
}
//#endregion
//#region node_modules/vinext/dist/server/cache-control.js
var STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";
var STALE_REVALIDATE_CACHE_CONTROL = "s-maxage=0, stale-while-revalidate";
/**
* Matches Next.js's `getCacheControlHeader` stale window semantics while
* preserving vinext's legacy unbounded SWR header when no expire ceiling is
* available yet.
*
* Next.js source:
* https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/cache-control.ts
*/
function buildRevalidateCacheControl(revalidateSeconds, expireSeconds) {
	if (expireSeconds === void 0) return `s-maxage=${revalidateSeconds}, stale-while-revalidate`;
	if (revalidateSeconds >= expireSeconds) return `s-maxage=${revalidateSeconds}`;
	return `s-maxage=${revalidateSeconds}, stale-while-revalidate=${expireSeconds - revalidateSeconds}`;
}
/**
* Builds Cache-Control for ISR cache reads. HIT responses and STALE responses
* with stored expire metadata use the same route policy because Next.js derives
* this header from cache-control metadata, not from the cache hit/stale state.
* STALE entries without expire metadata keep vinext's legacy `s-maxage=0`
* fallback so older cache entries are not treated as newly fresh downstream.
*/
function buildCachedRevalidateCacheControl(cacheState, revalidateSeconds, expireSeconds) {
	if (revalidateSeconds === Infinity) return STATIC_CACHE_CONTROL;
	if (cacheState === "STALE" && expireSeconds === void 0) return STALE_REVALIDATE_CACHE_CONTROL;
	return buildRevalidateCacheControl(revalidateSeconds, expireSeconds);
}
//#endregion
//#region node_modules/vinext/dist/shims/script-nonce-context.js
var ScriptNonceContext = React.createContext(void 0);
function ScriptNonceProvider(props) {
	return React.createElement(ScriptNonceContext.Provider, { value: props.nonce }, props.children);
}
function withScriptNonce(element, nonce) {
	if (!nonce) return element;
	return React.createElement(ScriptNonceProvider, { nonce }, element);
}
//#endregion
//#region node_modules/vinext/dist/server/pages-page-response.js
function buildPagesFontHeadHtml(fontLinks, fontPreloads, fontStyles, scriptNonce) {
	let html = "";
	const nonceAttr = createNonceAttribute(scriptNonce);
	for (const link of fontLinks) html += `<link rel="stylesheet"${nonceAttr} href="${escapeHtmlAttr(link)}" />\n  `;
	for (const preload of fontPreloads) html += `<link rel="preload"${nonceAttr} href="${escapeHtmlAttr(preload.href)}" as="font" type="${escapeHtmlAttr(preload.type)}" crossorigin />\n  `;
	if (fontStyles.length > 0) html += `<style data-vinext-fonts${nonceAttr}>${fontStyles.join("\n")}</style>\n  `;
	return html;
}
function buildPagesNextDataScript(options) {
	const nextDataPayload = {
		props: { pageProps: options.pageProps },
		page: options.routePattern,
		query: options.params,
		buildId: options.buildId,
		isFallback: false
	};
	if (options.i18n.locales) {
		nextDataPayload.locale = options.i18n.locale;
		nextDataPayload.locales = options.i18n.locales;
		nextDataPayload.defaultLocale = options.i18n.defaultLocale;
		nextDataPayload.domainLocales = options.i18n.domainLocales;
	}
	const localeGlobals = options.i18n.locales ? `;window.__VINEXT_LOCALE__=${options.safeJsonStringify(options.i18n.locale)};window.__VINEXT_LOCALES__=${options.safeJsonStringify(options.i18n.locales)};window.__VINEXT_DEFAULT_LOCALE__=${options.safeJsonStringify(options.i18n.defaultLocale)}` : "";
	return createInlineScriptTag(`window.__NEXT_DATA__ = ${options.safeJsonStringify(nextDataPayload)}${localeGlobals}`, options.scriptNonce);
}
async function buildPagesShellHtml(bodyMarker, fontHeadHTML, nextDataScript, options) {
	if (options.DocumentComponent) {
		let html = await options.renderDocumentToString(React.createElement(options.DocumentComponent));
		html = html.replace("__NEXT_MAIN__", bodyMarker);
		if (options.ssrHeadHTML || options.assetTags || fontHeadHTML) html = html.replace("</head>", `  ${fontHeadHTML}${options.ssrHeadHTML}\n  ${options.assetTags}\n</head>`);
		html = html.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
		if (!html.includes("__NEXT_DATA__")) html = html.replace("</body>", `  ${nextDataScript}\n</body>`);
		return html;
	}
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${fontHeadHTML}${options.ssrHeadHTML}\n  ${options.assetTags}\n</head>
<body>
  <div id="__next">${bodyMarker}</div>\n  ${nextDataScript}\n</body>
</html>`;
}
async function buildPagesCompositeStream(bodyStream, shellPrefix, shellSuffix) {
	const encoder = new TextEncoder();
	return new ReadableStream({ async start(controller) {
		controller.enqueue(encoder.encode(shellPrefix));
		const reader = bodyStream.getReader();
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				controller.enqueue(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		controller.enqueue(encoder.encode(shellSuffix));
		controller.close();
	} });
}
async function reportPagesIsrCacheWriteError(error, cacheKey, routePattern) {
	console.error(`[vinext] Pages ISR cache write failed for ${cacheKey}:`, error);
	try {
		await reportRequestError(error instanceof Error ? error : new Error(String(error)), {
			path: cacheKey,
			method: "GET",
			headers: {}
		}, {
			routerKind: "Pages Router",
			routePath: routePattern,
			routeType: "render"
		});
	} catch {}
}
function schedulePagesIsrCacheWrite(options) {
	const cacheWritePromise = readStreamAsText(options.stream).then((bodyHtml) => options.setCache(options.cacheKey, {
		kind: "PAGES",
		html: options.shellPrefix + bodyHtml + options.shellSuffix,
		pageData: options.pageData,
		headers: void 0,
		status: void 0
	}, options.revalidateSeconds, void 0, options.expireSeconds)).catch((error) => reportPagesIsrCacheWriteError(error, options.cacheKey, options.routePattern));
	getRequestExecutionContext()?.waitUntil(cacheWritePromise);
}
function applyGsspHeaders(headers, gsspRes) {
	if (!gsspRes) return 200;
	const gsspHeaders = gsspRes.getHeaders();
	for (const key of Object.keys(gsspHeaders)) {
		const value = gsspHeaders[key];
		if (key.toLowerCase() === "set-cookie" && Array.isArray(value)) {
			for (const cookie of value) headers.append("set-cookie", String(cookie));
			continue;
		}
		if (Array.isArray(value)) {
			headers.set(key, value.join(", "));
			continue;
		}
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") headers.set(key, String(value));
	}
	headers.set("Content-Type", "text/html");
	return gsspRes.statusCode;
}
async function renderPagesPageResponse(options) {
	const pageElement = withScriptNonce(React.createElement(React.Fragment, null, options.createPageElement(options.pageProps)), options.scriptNonce);
	options.resetSSRHead?.();
	await options.flushPreloads?.();
	const fontHeadHTML = buildPagesFontHeadHtml(options.getFontLinks(), options.fontPreloads, options.getFontStyles(), options.scriptNonce);
	const nextDataScript = buildPagesNextDataScript({
		buildId: options.buildId,
		i18n: options.i18n,
		pageProps: options.pageProps,
		params: options.params,
		routePattern: options.routePattern,
		safeJsonStringify: options.safeJsonStringify,
		scriptNonce: options.scriptNonce
	});
	const bodyMarker = "<!--VINEXT_STREAM_BODY-->";
	const bodyStream = await options.renderToReadableStream(pageElement);
	const shellHtml = await buildPagesShellHtml(bodyMarker, fontHeadHTML, nextDataScript, {
		assetTags: options.assetTags,
		DocumentComponent: options.DocumentComponent,
		renderDocumentToString: options.renderDocumentToString,
		ssrHeadHTML: options.getSSRHeadHTML?.() ?? ""
	});
	options.clearSsrContext();
	const markerIndex = shellHtml.indexOf(bodyMarker);
	const shellPrefix = shellHtml.slice(0, markerIndex);
	const shellSuffix = shellHtml.slice(markerIndex + 25);
	let responseBodyStream = bodyStream;
	if (!options.scriptNonce && options.isrRevalidateSeconds !== null && options.isrRevalidateSeconds > 0) {
		const cacheBodyStreamPair = bodyStream.tee();
		responseBodyStream = cacheBodyStreamPair[0];
		const cacheBodyStream = cacheBodyStreamPair[1];
		const isrPathname = options.routeUrl.split("?")[0];
		schedulePagesIsrCacheWrite({
			cacheKey: options.isrCacheKey("pages", isrPathname),
			expireSeconds: options.expireSeconds,
			pageData: options.pageProps,
			revalidateSeconds: options.isrRevalidateSeconds,
			routePattern: options.routePattern,
			setCache: options.isrSet,
			shellPrefix,
			shellSuffix,
			stream: cacheBodyStream
		});
	}
	const compositeStream = await buildPagesCompositeStream(responseBodyStream, shellPrefix, shellSuffix);
	const responseHeaders = new Headers({ "Content-Type": "text/html" });
	const finalStatus = applyGsspHeaders(responseHeaders, options.gsspRes);
	if (options.scriptNonce) responseHeaders.set("Cache-Control", "no-store, must-revalidate");
	else if (options.isrRevalidateSeconds) {
		responseHeaders.set("Cache-Control", buildRevalidateCacheControl(options.isrRevalidateSeconds, options.expireSeconds));
		responseHeaders.set(VINEXT_CACHE_HEADER, "MISS");
	}
	if (options.fontLinkHeader) responseHeaders.set("Link", options.fontLinkHeader);
	return Object.assign(new Response(compositeStream, {
		status: finalStatus,
		headers: responseHeaders
	}), { __vinextStreamedHtmlResponse: true });
}
//#endregion
//#region node_modules/vinext/dist/server/pages-page-data.js
function buildPagesNotFoundResponse() {
	return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>", {
		status: 404,
		headers: { "Content-Type": "text/html" }
	});
}
function buildPagesDataNotFoundResponse() {
	return new Response("404", { status: 404 });
}
function resolvePagesRedirectStatus(redirect) {
	return redirect.statusCode != null ? redirect.statusCode : redirect.permanent ? 308 : 307;
}
function matchesPagesStaticPath(pathEntry, params) {
	return Object.entries(pathEntry.params).every(([key, value]) => {
		const actual = params[key];
		if (Array.isArray(value)) return Array.isArray(actual) && value.join("/") === actual.join("/");
		return String(value) === String(actual);
	});
}
function buildPagesCacheResponse(html, cacheState, fontLinkHeader, revalidateSeconds, expireSeconds, cacheControl) {
	const effectiveRevalidateSeconds = cacheControl?.revalidate ?? revalidateSeconds ?? 60;
	const effectiveExpireSeconds = cacheControl === void 0 ? void 0 : cacheControl.expire ?? expireSeconds;
	const headers = {
		"Content-Type": "text/html",
		[VINEXT_CACHE_HEADER]: cacheState,
		"Cache-Control": buildCachedRevalidateCacheControl(cacheState, effectiveRevalidateSeconds, effectiveExpireSeconds)
	};
	if (fontLinkHeader) headers.Link = fontLinkHeader;
	return new Response(html, {
		status: 200,
		headers
	});
}
function rewritePagesCachedHtml(cachedHtml, freshBody, nextDataScript) {
	const bodyStart = cachedHtml.indexOf("<div id=\"__next\">");
	const contentStart = bodyStart >= 0 ? bodyStart + 17 : -1;
	const nextDataStart = cachedHtml.indexOf("<script>window.__NEXT_DATA__");
	if (contentStart >= 0 && nextDataStart >= 0) {
		const region = cachedHtml.slice(contentStart, nextDataStart);
		const lastCloseDiv = region.lastIndexOf("</div>");
		const gap = lastCloseDiv >= 0 ? region.slice(lastCloseDiv + 6) : "";
		const nextDataEnd = cachedHtml.indexOf("<\/script>", nextDataStart) + 9;
		const tail = cachedHtml.slice(nextDataEnd);
		return cachedHtml.slice(0, contentStart) + freshBody + "</div>" + gap + nextDataScript + tail;
	}
	return "<!DOCTYPE html>\n<html>\n<head>\n</head>\n<body>\n  <div id=\"__next\">" + freshBody + "</div>\n  " + nextDataScript + "\n</body>\n</html>";
}
async function renderPagesIsrHtml(options) {
	const freshBody = await options.renderIsrPassToStringAsync(options.createPageElement(options.pageProps));
	const nextDataScript = buildPagesNextDataScript({
		buildId: options.buildId,
		i18n: options.i18n,
		pageProps: options.pageProps,
		params: options.params,
		routePattern: options.routePattern,
		safeJsonStringify: options.safeJsonStringify
	});
	return rewritePagesCachedHtml(options.cachedHtml, freshBody, nextDataScript);
}
async function resolvePagesPageData(options) {
	if (typeof options.pageModule.getStaticPaths === "function" && options.route.isDynamic) {
		const pathsResult = await options.pageModule.getStaticPaths({
			locales: options.i18n.locales ?? [],
			defaultLocale: options.i18n.defaultLocale ?? ""
		});
		if ((pathsResult?.fallback ?? false) === false) {
			if (!(pathsResult?.paths ?? []).some((pathEntry) => matchesPagesStaticPath(pathEntry, options.params))) return {
				kind: "response",
				response: buildPagesNotFoundResponse()
			};
		}
	}
	let pageProps = {};
	let gsspRes = null;
	if (typeof options.pageModule.getServerSideProps === "function") {
		const { req, res, responsePromise } = options.createGsspReqRes();
		const result = await options.pageModule.getServerSideProps({
			params: options.params,
			req,
			res,
			query: options.query,
			resolvedUrl: options.routeUrl,
			locale: options.i18n.locale,
			locales: options.i18n.locales,
			defaultLocale: options.i18n.defaultLocale
		});
		if (res.headersSent) return {
			kind: "response",
			response: await responsePromise
		};
		if (result?.props) pageProps = result.props;
		if (result?.redirect) return {
			kind: "response",
			response: new Response(null, {
				status: resolvePagesRedirectStatus(result.redirect),
				headers: { Location: options.sanitizeDestination(result.redirect.destination) }
			})
		};
		if (result?.notFound) return {
			kind: "response",
			response: buildPagesDataNotFoundResponse()
		};
		gsspRes = res;
	}
	let isrRevalidateSeconds = null;
	if (typeof options.pageModule.getStaticProps === "function") {
		const pathname = options.routeUrl.split("?")[0];
		const cacheKey = options.isrCacheKey("pages", pathname);
		const cached = await options.isrGet(cacheKey);
		const cachedValue = cached?.value.value;
		if (cachedValue?.kind === "PAGES" && cached && !cached.isStale && !options.scriptNonce) return {
			kind: "response",
			response: buildPagesCacheResponse(cachedValue.html, "HIT", options.fontLinkHeader, void 0, options.expireSeconds, cached.value.cacheControl)
		};
		if (cachedValue?.kind === "PAGES" && cached && cached.isStale && !options.scriptNonce) {
			options.triggerBackgroundRegeneration(cacheKey, async function() {
				return options.runInFreshUnifiedContext(async () => {
					const freshResult = await options.pageModule.getStaticProps?.({
						params: options.params,
						locale: options.i18n.locale,
						locales: options.i18n.locales,
						defaultLocale: options.i18n.defaultLocale
					});
					if (freshResult?.props && typeof freshResult.revalidate === "number" && freshResult.revalidate > 0) {
						options.applyRequestContexts();
						const freshHtml = await renderPagesIsrHtml({
							buildId: options.buildId,
							cachedHtml: cachedValue.html,
							createPageElement: options.createPageElement,
							i18n: options.i18n,
							pageProps: freshResult.props,
							params: options.params,
							renderIsrPassToStringAsync: options.renderIsrPassToStringAsync,
							routePattern: options.routePattern,
							safeJsonStringify: options.safeJsonStringify
						});
						await options.isrSet(cacheKey, buildPagesCacheValue(freshHtml, freshResult.props), freshResult.revalidate, void 0, options.expireSeconds);
					}
				});
			}, {
				routerKind: "Pages Router",
				routePath: options.routePattern,
				routeType: "render"
			});
			return {
				kind: "response",
				response: buildPagesCacheResponse(cachedValue.html, "STALE", options.fontLinkHeader, void 0, options.expireSeconds, cached.value.cacheControl)
			};
		}
		const result = await options.pageModule.getStaticProps({
			params: options.params,
			locale: options.i18n.locale,
			locales: options.i18n.locales,
			defaultLocale: options.i18n.defaultLocale
		});
		if (result?.props) pageProps = result.props;
		if (result?.redirect) return {
			kind: "response",
			response: new Response(null, {
				status: resolvePagesRedirectStatus(result.redirect),
				headers: { Location: options.sanitizeDestination(result.redirect.destination) }
			})
		};
		if (result?.notFound) return {
			kind: "response",
			response: buildPagesDataNotFoundResponse()
		};
		if (typeof result?.revalidate === "number" && result.revalidate > 0) isrRevalidateSeconds = result.revalidate;
	}
	return {
		kind: "render",
		gsspRes,
		isrRevalidateSeconds,
		pageProps
	};
}
//#endregion
//#region node_modules/lucide-react/dist/esm/shared/src/utils.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
	return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();
//#endregion
//#region node_modules/lucide-react/dist/esm/defaultAttributes.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var defaultAttributes = {
	xmlns: "http://www.w3.org/2000/svg",
	width: 24,
	height: 24,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round",
	strokeLinejoin: "round"
};
//#endregion
//#region node_modules/lucide-react/dist/esm/Icon.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Icon = forwardRef(({ color = "currentColor", size = 24, strokeWidth = 2, absoluteStrokeWidth, className = "", children, iconNode, ...rest }, ref) => {
	return createElement("svg", {
		ref,
		...defaultAttributes,
		width: size,
		height: size,
		stroke: color,
		strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
		className: mergeClasses("lucide", className),
		...rest
	}, [...iconNode.map(([tag, attrs]) => createElement(tag, attrs)), ...Array.isArray(children) ? children : [children]]);
});
//#endregion
//#region node_modules/lucide-react/dist/esm/createLucideIcon.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var createLucideIcon = (iconName, iconNode) => {
	const Component = forwardRef(({ className, ...props }, ref) => createElement(Icon, {
		ref,
		iconNode,
		className: mergeClasses(`lucide-${toKebabCase(iconName)}`, className),
		...props
	}));
	Component.displayName = `${iconName}`;
	return Component;
};
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/activity.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Activity = createLucideIcon("Activity", [["path", {
	d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
	key: "169zse"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/triangle-alert.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var TriangleAlert = createLucideIcon("TriangleAlert", [
	["path", {
		d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
		key: "wmoenq"
	}],
	["path", {
		d: "M12 9v4",
		key: "juzpu7"
	}],
	["path", {
		d: "M12 17h.01",
		key: "p32p05"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/arrow-left.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ArrowLeft = createLucideIcon("ArrowLeft", [["path", {
	d: "m12 19-7-7 7-7",
	key: "1l729n"
}], ["path", {
	d: "M19 12H5",
	key: "x3x0zl"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/bell.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Bell = createLucideIcon("Bell", [["path", {
	d: "M10.268 21a2 2 0 0 0 3.464 0",
	key: "vwvbt9"
}], ["path", {
	d: "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
	key: "11g9vi"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/briefcase-business.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var BriefcaseBusiness = createLucideIcon("BriefcaseBusiness", [
	["path", {
		d: "M12 12h.01",
		key: "1mp3jc"
	}],
	["path", {
		d: "M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2",
		key: "1ksdt3"
	}],
	["path", {
		d: "M22 13a18.15 18.15 0 0 1-20 0",
		key: "12hx5q"
	}],
	["rect", {
		width: "20",
		height: "14",
		x: "2",
		y: "6",
		rx: "2",
		key: "i6l2r4"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/check.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Check = createLucideIcon("Check", [["path", {
	d: "M20 6 9 17l-5-5",
	key: "1gmf2c"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/chevron-down.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ChevronDown = createLucideIcon("ChevronDown", [["path", {
	d: "m6 9 6 6 6-6",
	key: "qrunsl"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/chevron-right.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ChevronRight = createLucideIcon("ChevronRight", [["path", {
	d: "m9 18 6-6-6-6",
	key: "mthhwq"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/database.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Database = createLucideIcon("Database", [
	["ellipse", {
		cx: "12",
		cy: "5",
		rx: "9",
		ry: "3",
		key: "msslwz"
	}],
	["path", {
		d: "M3 5V19A9 3 0 0 0 21 19V5",
		key: "1wlel7"
	}],
	["path", {
		d: "M3 12A9 3 0 0 0 21 12",
		key: "mv7ke4"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/filter.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Filter = createLucideIcon("Filter", [["polygon", {
	points: "22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3",
	key: "1yg77f"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/git-compare-arrows.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var GitCompareArrows = createLucideIcon("GitCompareArrows", [
	["circle", {
		cx: "5",
		cy: "6",
		r: "3",
		key: "1qnov2"
	}],
	["path", {
		d: "M12 6h5a2 2 0 0 1 2 2v7",
		key: "1yj91y"
	}],
	["path", {
		d: "m15 9-3-3 3-3",
		key: "1lwv8l"
	}],
	["circle", {
		cx: "19",
		cy: "18",
		r: "3",
		key: "1qljk2"
	}],
	["path", {
		d: "M12 18H7a2 2 0 0 1-2-2V9",
		key: "16sdep"
	}],
	["path", {
		d: "m9 15 3 3-3 3",
		key: "1m3kbl"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/infinity.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Infinity$1 = createLucideIcon("Infinity", [["path", {
	d: "M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z",
	key: "1z0uae"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/layout-dashboard.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var LayoutDashboard = createLucideIcon("LayoutDashboard", [
	["rect", {
		width: "7",
		height: "9",
		x: "3",
		y: "3",
		rx: "1",
		key: "10lvy0"
	}],
	["rect", {
		width: "7",
		height: "5",
		x: "14",
		y: "3",
		rx: "1",
		key: "16une8"
	}],
	["rect", {
		width: "7",
		height: "9",
		x: "14",
		y: "12",
		rx: "1",
		key: "1hutg5"
	}],
	["rect", {
		width: "7",
		height: "5",
		x: "3",
		y: "16",
		rx: "1",
		key: "ldoo1y"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/list-filter.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ListFilter = createLucideIcon("ListFilter", [
	["path", {
		d: "M3 6h18",
		key: "d0wm0j"
	}],
	["path", {
		d: "M7 12h10",
		key: "b7w52i"
	}],
	["path", {
		d: "M10 18h4",
		key: "1ulq68"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/plus.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Plus = createLucideIcon("Plus", [["path", {
	d: "M5 12h14",
	key: "1ays0h"
}], ["path", {
	d: "M12 5v14",
	key: "s699le"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/rotate-ccw.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var RotateCcw = createLucideIcon("RotateCcw", [["path", {
	d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",
	key: "1357e3"
}], ["path", {
	d: "M3 3v5h5",
	key: "1xhq8a"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/search.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Search = createLucideIcon("Search", [["circle", {
	cx: "11",
	cy: "11",
	r: "8",
	key: "4ej97u"
}], ["path", {
	d: "m21 21-4.3-4.3",
	key: "1qie3q"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/settings-2.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Settings2 = createLucideIcon("Settings2", [
	["path", {
		d: "M20 7h-9",
		key: "3s1dr2"
	}],
	["path", {
		d: "M14 17H5",
		key: "gfn3mx"
	}],
	["circle", {
		cx: "17",
		cy: "17",
		r: "3",
		key: "18b49y"
	}],
	["circle", {
		cx: "7",
		cy: "7",
		r: "3",
		key: "dfmy0x"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/bell-ring.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var BellRing = createLucideIcon("BellRing", [
	["path", {
		d: "M10.268 21a2 2 0 0 0 3.464 0",
		key: "vwvbt9"
	}],
	["path", {
		d: "M22 8c0-2.3-.8-4.3-2-6",
		key: "5bb3ad"
	}],
	["path", {
		d: "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
		key: "11g9vi"
	}],
	["path", {
		d: "M4 2C2.8 3.7 2 5.7 2 8",
		key: "tap9e0"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/circle-user-round.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var CircleUserRound = createLucideIcon("CircleUserRound", [
	["path", {
		d: "M18 20a6 6 0 0 0-12 0",
		key: "1qehca"
	}],
	["circle", {
		cx: "12",
		cy: "10",
		r: "4",
		key: "1h16sb"
	}],
	["circle", {
		cx: "12",
		cy: "12",
		r: "10",
		key: "1mglay"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/clipboard-check.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ClipboardCheck = createLucideIcon("ClipboardCheck", [
	["rect", {
		width: "8",
		height: "4",
		x: "8",
		y: "2",
		rx: "1",
		ry: "1",
		key: "tgr4d6"
	}],
	["path", {
		d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
		key: "116196"
	}],
	["path", {
		d: "m9 14 2 2 4-4",
		key: "df797q"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/panel-left-close.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var PanelLeftClose = createLucideIcon("PanelLeftClose", [
	["rect", {
		width: "18",
		height: "18",
		x: "3",
		y: "3",
		rx: "2",
		key: "afitv7"
	}],
	["path", {
		d: "M9 3v18",
		key: "fh3hqa"
	}],
	["path", {
		d: "m16 15-3-3 3-3",
		key: "14y99z"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/panel-left-open.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var PanelLeftOpen = createLucideIcon("PanelLeftOpen", [
	["rect", {
		width: "18",
		height: "18",
		x: "3",
		y: "3",
		rx: "2",
		key: "afitv7"
	}],
	["path", {
		d: "M9 3v18",
		key: "fh3hqa"
	}],
	["path", {
		d: "m14 9 3 3-3 3",
		key: "8010ee"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/send.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Send = createLucideIcon("Send", [["path", {
	d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
	key: "1ffxy3"
}], ["path", {
	d: "m21.854 2.147-10.94 10.939",
	key: "12cjpa"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/shield-check.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ShieldCheck = createLucideIcon("ShieldCheck", [["path", {
	d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
	key: "oel41y"
}], ["path", {
	d: "m9 12 2 2 4-4",
	key: "dzmm74"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/sliders-horizontal.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var SlidersHorizontal = createLucideIcon("SlidersHorizontal", [
	["line", {
		x1: "21",
		x2: "14",
		y1: "4",
		y2: "4",
		key: "obuewd"
	}],
	["line", {
		x1: "10",
		x2: "3",
		y1: "4",
		y2: "4",
		key: "1q6298"
	}],
	["line", {
		x1: "21",
		x2: "12",
		y1: "12",
		y2: "12",
		key: "1iu8h1"
	}],
	["line", {
		x1: "8",
		x2: "3",
		y1: "12",
		y2: "12",
		key: "ntss68"
	}],
	["line", {
		x1: "21",
		x2: "16",
		y1: "20",
		y2: "20",
		key: "14d8ph"
	}],
	["line", {
		x1: "12",
		x2: "3",
		y1: "20",
		y2: "20",
		key: "m0wm8r"
	}],
	["line", {
		x1: "14",
		x2: "14",
		y1: "2",
		y2: "6",
		key: "14e1ph"
	}],
	["line", {
		x1: "8",
		x2: "8",
		y1: "10",
		y2: "14",
		key: "1i6ji0"
	}],
	["line", {
		x1: "16",
		x2: "16",
		y1: "18",
		y2: "22",
		key: "1lctlv"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/sparkles.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Sparkles = createLucideIcon("Sparkles", [
	["path", {
		d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
		key: "4pj2yx"
	}],
	["path", {
		d: "M20 3v4",
		key: "1olli1"
	}],
	["path", {
		d: "M22 5h-4",
		key: "1gvqau"
	}],
	["path", {
		d: "M4 17v2",
		key: "vumght"
	}],
	["path", {
		d: "M5 18H3",
		key: "zchphs"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/users.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var Users = createLucideIcon("Users", [
	["path", {
		d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
		key: "1yyitq"
	}],
	["circle", {
		cx: "9",
		cy: "7",
		r: "4",
		key: "nufk8"
	}],
	["path", {
		d: "M22 21v-2a4 4 0 0 0-3-3.87",
		key: "kshegd"
	}],
	["path", {
		d: "M16 3.13a4 4 0 0 1 0 7.75",
		key: "1da9ce"
	}]
]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/x.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var X = createLucideIcon("X", [["path", {
	d: "M18 6 6 18",
	key: "1bl5f8"
}], ["path", {
	d: "m6 6 12 12",
	key: "d8bk6v"
}]]);
//#endregion
//#region app/decision-demo.ts
var replay = (id, rank, reasons, risks, evidence) => ({
	decisionId: `D-${id.slice(4)}`,
	runId: "RUN-1842",
	snapshotAt: "2026-08-10 11:28",
	policyVersion: "Policy v1.2",
	rank,
	reasons,
	risks,
	evidence
});
replay("PRJ-1829", 1, ["项目关系明确，当前阶段具备优先验证价值。"], ["Offer 与 HC 为 UNKNOWN，不能按历史 Pipeline 乐观推断。"], ["项目快照 · 08-08 11:28", "权限状态 · 项目详情受限"]), replay("PRJ-1674", 2, ["反馈持续、二面推进，剩余 HC 已确认。"], ["与项目为团队共享关系。"], [
	"客户反馈 · 08-09",
	"阶段事件 · 二面推进",
	"职位快照 · HC 2"
]), replay("PRJ-1912", 3, ["新项目信号积极。"], ["尚未加入项目，归属与 HC 都未确认。"], ["职位发布 · 08-09", "归属字段 · 缺失"]), replay("PRJ-1733", 4, ["反馈窗口明确，阶段具备推进动能。"], ["当前剩余 HC 仅 1。"], ["客户反馈 · 08-10", "HC 字段 · 1"]), replay("PRJ-1608", 8, ["职位仍有效。"], ["近期无新增阶段事件。"], ["项目快照 · 08-05"]), replay("PRJ-1498", 22, ["项目归属明确。"], ["HC 已确认为 0，职位关闭。"], ["客户确认 · 08-08", "HC 字段 · 0"]);
var seedSync = {
	state: "READY",
	updatedAt: "11:28",
	rowsRead: 37,
	rowsExpected: 37
};
var seedAuth = {
	consultant: "Felix",
	authorized: true,
	needsReauth: false
};
var seedNotifications = [
	{
		id: "daily",
		kind: "DAILY_TOP3",
		title: "三方向 Top 3 已生成",
		detail: "投放、增长负责人、市场负责人等待判断",
		jobId: "JU87P01",
		read: false
	},
	{
		id: "commit",
		kind: "COMMITMENT",
		title: "2 个承接需要处理",
		detail: "39-AI 与科漫智能仍有下一动作",
		jobId: "JVS2PHH",
		read: false
	},
	{
		id: "sync",
		kind: "SYNC_ALERT",
		title: "同步状态正常",
		detail: "当前完整快照已进入本轮职位判断",
		read: true
	}
];
var actionLabel = {
	WATCH: "关注",
	UNWATCH: "取消关注",
	ACCEPT: "接单",
	DISMISS: "暂不考虑",
	RELEASE: "释放",
	COMPLETE: "完成"
};
var stateLabel = {
	NEW: "未开始",
	RECOMMENDED: "已推荐",
	VIEWED: "已查看",
	WATCHED: "关注中",
	ACCEPTED: "已接单",
	DISMISSED: "暂不考虑",
	RELEASED: "已释放",
	COMPLETED: "已完成"
};
//#endregion
//#region app/workbench.tsx
var decisionGroupMeta = {
	RESULT_CLOSURE: {
		title: "结果收口",
		subtitle: "别丢单，先把当前结果确认下来"
	},
	ACTIVE_ADVANCEMENT: {
		title: "高动能推进",
		subtitle: "现在有真实动能，优先顺势推进"
	},
	NEW_VALIDATION: {
		title: "新机会验证",
		subtitle: "值得看，但先验证关键事实"
	},
	MAINTENANCE: {
		title: "维护观察",
		subtitle: "项目仍有效，暂不抢占今天注意力"
	},
	EXCLUDE: {
		title: "暂不推荐",
		subtitle: "硬条件不符合，不进入正式推荐"
	}
};
var decisionJobs = [
	{
		id: "JU87P01",
		direction: "paid",
		rank: 1,
		company: "39-AI",
		role: "资深海外投放经理",
		relation: "我的职位",
		sourceMode: "COCKPIT_CONTEXT",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 22 · 面试 2 · 寻访 1",
		process: 82,
		exploration: 76,
		personal: 81,
		final: 80,
		group: "ACTIVE_ADVANCEMENT",
		reasons: [
			"已进入面试阶段，项目具有真实推进动能。",
			"驾驶舱已有 20 名推荐样本和 2 名面试样本。",
			"HC 1，当前入职 0，剩余 HC 1。"
		],
		risks: ["客户最新反馈和下一轮推荐动作仍需回写。"],
		nextAction: "按驾驶舱下一动作推进，并在 72 小时内回写信号",
		evidence: [
			"驾驶舱项目快照",
			"Pipeline 阶段记录",
			"HC 占用判断"
		]
	},
	{
		id: "J3NBVPJ",
		direction: "paid",
		rank: 2,
		company: "上海蝴蝶梦境科技有限公司",
		role: "资深广告优化师",
		relation: "未加入",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 3 · 面试 3",
		process: 78,
		exploration: 95,
		personal: 64,
		final: 80,
		group: "NEW_VALIDATION",
		reasons: ["市场职位处于面试阶段，且仍有明确 HC。", "探索价值高，但尚未匹配到驾驶舱 project_id。"],
		risks: ["项目负责人和当前 HC 需要在承接前再次确认。"],
		nextAction: "确认负责人和 HC，再做 72 小时低成本验证",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"HC 字段"
		]
	},
	{
		id: "JPG4HAS",
		direction: "paid",
		rank: 3,
		company: "Aha.AI",
		role: "B2B 投放专员",
		relation: "我的职位",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 2 · 面试 1",
		process: 75,
		exploration: 95,
		personal: 71,
		final: 79,
		group: "ACTIVE_ADVANCEMENT",
		reasons: ["职位市场显示已有面试推进，方向匹配度高。", "当前快照未找到可确认的驾驶舱 project_id。"],
		risks: ["不能把公司名相似当作驾驶舱关联证据。"],
		nextAction: "核验项目归属和 HC，再决定投入寻访",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"顾问关系"
		]
	},
	{
		id: "JNDLIXO",
		direction: "growth",
		rank: 1,
		company: "北京雨林时代科技有限公司",
		role: "海外增长负责人",
		relation: "我的职位",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 2,
		pipeline: "推荐 3 · 面试 10",
		process: 85,
		exploration: 95,
		personal: 71,
		final: 85,
		group: "ACTIVE_ADVANCEMENT",
		reasons: ["10 名面试样本证明需求处于真实推进阶段。", "总 HC 2，当前仍有 2 个机会空间。"],
		risks: ["未匹配驾驶舱上下文，需确认竞争与项目负责人。"],
		nextAction: "确认负责人和 HC，再做 72 小时低成本验证",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"HC 字段"
		]
	},
	{
		id: "JPZ5RC5",
		direction: "growth",
		rank: 2,
		company: "CurioSea",
		role: "GTM Leader / 全球增长负责人",
		relation: "未加入",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 10 · 面试 14 · 寻访 1",
		process: 83,
		exploration: 95,
		personal: 64,
		final: 83,
		group: "NEW_VALIDATION",
		reasons: ["市场 Pipeline 活跃，面试与推荐样本充分。", "方向吻合，但顾问尚未加入项目。"],
		risks: ["未加入项目，不能直接出现接单动作。"],
		nextAction: "确认项目归属与可承接状态，再决定是否加入",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"项目关系字段"
		]
	},
	{
		id: "JVS2PHH",
		direction: "growth",
		rank: 3,
		company: "科漫智能",
		role: "海外增长运营负责人 / 经理",
		relation: "我的职位",
		sourceMode: "COCKPIT_CONTEXT",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 28 · 面试 7 · 寻访 3",
		process: 85,
		exploration: 75,
		personal: 81,
		final: 82,
		group: "ACTIVE_ADVANCEMENT",
		reasons: ["驾驶舱已记录岗位拆解、30 人联系池和首轮验证。", "项目处于面试阶段，HC 仍开放。"],
		risks: ["客户优先级、联系回复和硬条件尚需进一步确认。"],
		nextAction: "按驾驶舱下一动作推进，并在 72 小时内回写信号",
		evidence: [
			"驾驶舱项目快照",
			"岗位拆解记录",
			"Pipeline 阶段记录"
		]
	},
	{
		id: "J90P3H0",
		direction: "marketing",
		rank: 1,
		company: "中科酷原",
		role: "市场总监 / 经理",
		relation: "未加入",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 5,
		pipeline: "推荐 1 · 面试 9",
		process: 87,
		exploration: 95,
		personal: 64,
		final: 86,
		group: "NEW_VALIDATION",
		reasons: ["存在 5 个剩余 HC，机会空间明确。", "已有 9 名面试样本，项目需求处于活跃状态。"],
		risks: ["尚未加入项目，需确认项目负责人和承接规则。"],
		nextAction: "确认负责人和 HC，再做 72 小时低成本验证",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"HC 字段"
		]
	},
	{
		id: "JBWXJ7W",
		direction: "marketing",
		rank: 2,
		company: "深势科技",
		role: "Marketing Head（科研产品）",
		relation: "未加入",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 3 · 面试 3",
		process: 78,
		exploration: 95,
		personal: 64,
		final: 80,
		group: "NEW_VALIDATION",
		reasons: ["方向吻合，市场 Pipeline 已有真实推进。", "剩余 HC 1，仍有机会空间。"],
		risks: ["项目未加入，驾驶舱上下文不可用。"],
		nextAction: "确认项目归属、客户优先级和当前 HC",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"HC 字段"
		]
	},
	{
		id: "JU2GCAC",
		direction: "marketing",
		rank: 3,
		company: "天瞳威视",
		role: "市场与媒体公关总监",
		relation: "未加入",
		sourceMode: "MARKET_ONLY",
		stage: "INTERVIEW",
		remainingHc: 1,
		pipeline: "推荐 12 · 面试 9 · 寻访 7",
		process: 84,
		exploration: 76,
		personal: 64,
		final: 79,
		group: "ACTIVE_ADVANCEMENT",
		reasons: ["项目 Pipeline 充分，已有推荐和面试推进。", "HC 1，当前仍有可验证机会。"],
		risks: ["市场竞争可能偏高，且缺少驾驶舱项目上下文。"],
		nextAction: "核验竞争强度和项目归属后，再决定投入级别",
		evidence: [
			"职位市场快照",
			"市场 Pipeline",
			"HC 字段"
		]
	}
].map((seed) => ({
	id: seed.id,
	rank: seed.rank,
	company: seed.company,
	role: seed.role,
	direction: seed.direction,
	sourceMode: seed.sourceMode,
	group: seed.group,
	eligibility: "ELIGIBLE",
	globalScore: seed.process,
	explorationScore: seed.exploration,
	personalScore: seed.personal,
	finalScore: seed.final,
	evidenceCoverage: null,
	recommendation: seed.nextAction,
	recentSignal: `${seed.stage} · 剩余 HC ${seed.remainingHc}`,
	facts: {
		"职位关系": seed.relation,
		"数据来源": seed.sourceMode === "COCKPIT_CONTEXT" ? "驾驶舱上下文" : "职位市场",
		"当前阶段": seed.stage,
		"剩余 HC": String(seed.remainingHc),
		"Offer 状态": "0",
		"入职状态": "0",
		"历史 Pipeline": seed.pipeline
	},
	scoreNotes: seed.reasons,
	risks: seed.risks,
	evidence: seed.evidence,
	actions: seed.relation === "未加入" ? [{
		id: "verify",
		label: "确认项目归属",
		kind: "verify",
		detail: "先确认负责人和承接状态"
	}] : [{
		id: "advance",
		label: "进入项目推进",
		kind: "advance",
		detail: seed.nextAction
	}, {
		id: "watch",
		label: "加入观察",
		kind: "watch",
		detail: "保留本周提醒"
	}]
}));
var verificationJobs = [
	[
		"JS6ZVBW",
		"Nooklab",
		"DTC负责人",
		"Offer 1 覆盖剩余 HC 1，入职未确认"
	],
	[
		"JFL41BC",
		"SigmaZ",
		"平台增长负责人",
		"Offer 1 覆盖剩余 HC 1，入职未确认"
	],
	[
		"JH1ORT9",
		"refly.ai",
		"增长运营 / KOL / 投放",
		"Offer 2 覆盖剩余 HC 2，入职未确认"
	]
].map(([id, company, role, note], index) => ({
	id,
	rank: index + 1,
	company,
	role,
	direction: index === 0 ? "growth" : index === 1 ? "growth" : "paid",
	sourceMode: "MARKET_ONLY",
	group: "RESULT_CLOSURE",
	eligibility: "VERIFY_REQUIRED",
	globalScore: 0,
	explorationScore: 0,
	personalScore: 0,
	finalScore: 0,
	evidenceCoverage: null,
	recommendation: "核验 Offer 与入职状态",
	recentSignal: note,
	facts: {
		"职位关系": "待确认",
		"数据来源": "职位市场",
		"当前阶段": "OFFER",
		"剩余 HC": "UNKNOWN",
		"Offer 状态": "已发出",
		"入职状态": "UNKNOWN",
		"历史 Pipeline": "待核验"
	},
	scoreNotes: ["Offer 已覆盖当前 HC，但入职结果未知。"],
	risks: [note],
	evidence: [
		"职位市场快照",
		"Offer 状态字段",
		"入职状态缺失"
	],
	actions: [{
		id: "verify",
		label: "去确认状态",
		kind: "verify",
		detail: "确认 Offer、入职和剩余 HC"
	}]
}));
var jobs = [
	{
		id: 1,
		name: "AI 广告销售负责人",
		client: "星河科技",
		industry: "人工智能",
		city: "上海",
		pm: "林书言",
		status: "升温",
		score: 92,
		hc: 3,
		feedback: "2小时前",
		recommended: 8,
		interview: 3,
		offer: 0,
		reason: "48小时反馈提速，HC由2增至3",
		salary: "70–100K"
	},
	{
		id: 2,
		name: "海外增长负责人",
		client: "纬度引擎",
		industry: "跨境电商",
		city: "深圳",
		pm: "周既明",
		status: "拥挤",
		score: 78,
		hc: 2,
		feedback: "5小时前",
		recommended: 14,
		interview: 5,
		offer: 1,
		reason: "已有5人面试，竞争进入高位",
		salary: "60–85K"
	},
	{
		id: 3,
		name: "商业化增长经理",
		client: "棱镜互动",
		industry: "营销科技",
		city: "北京",
		pm: "许嘉禾",
		status: "降温",
		score: 63,
		hc: 1,
		feedback: "3天前",
		recommended: 9,
		interview: 1,
		offer: 0,
		reason: "反馈放缓且预算低于市场中位数",
		salary: "35–45K"
	},
	{
		id: 4,
		name: "AI 产品运营负责人",
		client: "澄明智能",
		industry: "人工智能",
		city: "杭州",
		pm: "沈青",
		status: "活跃",
		score: 86,
		hc: 2,
		feedback: "8小时前",
		recommended: 6,
		interview: 2,
		offer: 0,
		reason: "客户连续两轮在24小时内反馈",
		salary: "50–75K"
	},
	{
		id: 5,
		name: "Creator Partnership 负责人",
		client: "远屿网络",
		industry: "内容平台",
		city: "上海",
		pm: "陆弦",
		status: "新发布",
		score: 82,
		hc: 4,
		feedback: "1天前",
		recommended: 3,
		interview: 0,
		offer: 0,
		reason: "新发布且4个HC，需求画像已确认",
		salary: "45–65K"
	},
	{
		id: 6,
		name: "海外渠道销售",
		client: "云帆智能",
		industry: "企业服务",
		city: "深圳",
		pm: "林书言",
		status: "疑似失活",
		score: 41,
		hc: 2,
		feedback: "7天前",
		recommended: 11,
		interview: 1,
		offer: 0,
		reason: "连续7天无反馈，剩余HC未确认",
		salary: "40–60K"
	},
	{
		id: 7,
		name: "用户增长负责人",
		client: "拾光生活",
		industry: "消费科技",
		city: "北京",
		pm: "周既明",
		status: "升温",
		score: 88,
		hc: 2,
		feedback: "4小时前",
		recommended: 7,
		interview: 3,
		offer: 1,
		reason: "新增Offer且反馈时间缩短至12小时",
		salary: "55–80K"
	},
	{
		id: 8,
		name: "增长策略负责人",
		client: "矩阵工场",
		industry: "SaaS",
		city: "杭州",
		pm: "沈青",
		status: "活跃",
		score: 80,
		hc: 1,
		feedback: "20小时前",
		recommended: 5,
		interview: 2,
		offer: 0,
		reason: "面试转化稳定，业务负责人持续参与",
		salary: "50–70K"
	},
	{
		id: 9,
		name: "AI 解决方案销售",
		client: "澄明智能",
		industry: "人工智能",
		city: "北京",
		pm: "许嘉禾",
		status: "拥挤",
		score: 72,
		hc: 3,
		feedback: "9小时前",
		recommended: 18,
		interview: 6,
		offer: 1,
		reason: "参与顾问增至6人，推荐密度过高",
		salary: "45–70K"
	},
	{
		id: 10,
		name: "国际化产品增长",
		client: "远屿网络",
		industry: "内容平台",
		city: "上海",
		pm: "陆弦",
		status: "已关闭",
		score: 0,
		hc: 0,
		feedback: "2天前",
		recommended: 12,
		interview: 4,
		offer: 1,
		reason: "客户确认HC已全部关闭",
		salary: "45–65K"
	}
];
Array.from({ length: 24 }, (_, i) => jobs[i % jobs.length]);
var clients = [
	{
		name: "星河科技",
		industry: "人工智能",
		state: "招聘窗口期",
		active: 4,
		hc: 9,
		feedback: "18h",
		r2i: "38%",
		i2o: "24%",
		hires: 12,
		intent: "强",
		score: 94,
		risk: "面试标准抬高"
	},
	{
		name: "澄明智能",
		industry: "人工智能",
		state: "稳定合作",
		active: 3,
		hc: 7,
		feedback: "22h",
		r2i: "34%",
		i2o: "19%",
		hires: 8,
		intent: "强",
		score: 89,
		risk: "顾问竞争增加"
	},
	{
		name: "远屿网络",
		industry: "内容平台",
		state: "招聘窗口期",
		active: 4,
		hc: 8,
		feedback: "30h",
		r2i: "28%",
		i2o: "17%",
		hires: 6,
		intent: "较强",
		score: 85,
		risk: "海外画像不稳定"
	},
	{
		name: "拾光生活",
		industry: "消费科技",
		state: "稳定合作",
		active: 2,
		hc: 4,
		feedback: "16h",
		r2i: "41%",
		i2o: "25%",
		hires: 9,
		intent: "强",
		score: 88,
		risk: "薪资空间有限"
	},
	{
		name: "纬度引擎",
		industry: "跨境电商",
		state: "反馈降温",
		active: 3,
		hc: 5,
		feedback: "54h",
		r2i: "31%",
		i2o: "15%",
		hires: 5,
		intent: "中",
		score: 71,
		risk: "面试拥挤"
	},
	{
		name: "棱镜互动",
		industry: "营销科技",
		state: "需求不明确",
		active: 2,
		hc: 2,
		feedback: "72h",
		r2i: "19%",
		i2o: "8%",
		hires: 3,
		intent: "弱",
		score: 56,
		risk: "预算低于市场"
	},
	{
		name: "矩阵工场",
		industry: "SaaS",
		state: "稳定合作",
		active: 2,
		hc: 3,
		feedback: "28h",
		r2i: "30%",
		i2o: "18%",
		hires: 7,
		intent: "较强",
		score: 81,
		risk: "决策链较长"
	},
	{
		name: "云帆智能",
		industry: "企业服务",
		state: "高风险",
		active: 1,
		hc: 2,
		feedback: "168h",
		r2i: "14%",
		i2o: "0%",
		hires: 1,
		intent: "弱",
		score: 39,
		risk: "7天无反馈"
	}
];
var actionSeed = [
	[
		"紧急",
		"AI 广告销售负责人",
		"优先推进，今天补充2名高匹配人选",
		"HC增至3且反馈速度提升",
		"预计缩短5天交付周期"
	],
	[
		"关注",
		"海外增长负责人",
		"暂停泛化寻访，提高推荐门槛",
		"已有5人进入面试",
		"减少约8小时无效投入"
	],
	[
		"机会",
		"星河科技",
		"将两名顾问调配至重点职位",
		"过去48小时反馈明显加快",
		"本周面试 +3"
	],
	[
		"紧急",
		"云帆智能",
		"向PM确认需求是否仍然有效",
		"连续7天没有反馈",
		"避免继续无效投入"
	],
	[
		"关注",
		"商业化增长经理",
		"重新确认薪资预算",
		"预算低于市场中位数约18%",
		"提升推荐转化"
	],
	[
		"机会",
		"AI 产品运营负责人",
		"扩展头部AI应用公司名单",
		"反馈稳定且仍有2个HC",
		"本周推荐 +4"
	]
];
var events = [
	[
		"14:20",
		"职位升温",
		"AI 广告销售负责人 · HC 2 → 3"
	],
	[
		"12:45",
		"客户反馈",
		"星河科技反馈2份简历，均进入初面"
	],
	[
		"11:10",
		"Offer 产生",
		"用户增长负责人产生1个Offer"
	],
	[
		"09:35",
		"反馈异常",
		"云帆智能已连续7天未反馈"
	],
	[
		"昨天",
		"职位关闭",
		"国际化产品增长 · HC已全部关闭"
	]
];
var statusOrder = [
	"新发布",
	"升温",
	"活跃",
	"拥挤",
	"降温",
	"疑似失活",
	"已关闭"
];
var nav = [
	[
		"today",
		"今日决策",
		LayoutDashboard
	],
	[
		"jobs",
		"职位雷达",
		Activity
	],
	[
		"clients",
		"客户洞察",
		Users
	],
	[
		"alerts",
		"动态预警",
		Bell
	],
	[
		"rules",
		"决策规则",
		SlidersHorizontal
	],
	[
		"sources",
		"数据源",
		Database
	]
];
var sourceNames = [
	"内部项目驾驶舱",
	"职位库",
	"客户管理记录",
	"飞书文档",
	"飞书消息",
	"邮件反馈",
	"历史交付记录"
];
var SIDEBAR_MIN_WIDTH = 252;
var SIDEBAR_MAX_WIDTH = 336;
var SIDEBAR_COLLAPSE_DISTANCE = 36;
var SIDEBAR_EXPAND_DISTANCE = 12;
function readSavedWorkbenchState() {
	if (typeof document === "undefined") return {};
	try {
		return JSON.parse(localStorage.getItem("decision-workbench") || "{}");
	} catch {
		return {};
	}
}
var initialEngagement = {
	"JU87P01": "WATCHED",
	"JVS2PHH": "ACCEPTED",
	"JPG4HAS": "VIEWED"
};
var initialEvents = {
	"JU87P01": [{
		id: "evt-1",
		type: "已关注",
		at: "08-11 11:31"
	}],
	"JVS2PHH": [{
		id: "evt-2",
		type: "已接单",
		at: "08-11 16:20"
	}]
};
var initialOutcomes = { "JVS2PHH": [{
	id: "out-1",
	stage: "面试",
	rating: 4,
	note: "已完成首轮供给验证",
	at: "08-11 10:18"
}] };
function legalActions(job, state) {
	if (job.facts["职位关系"] === "未加入" || job.eligibility !== "ELIGIBLE") return [];
	if (state === "WATCHED") return [
		"UNWATCH",
		"ACCEPT",
		"DISMISS"
	];
	if (state === "ACCEPTED") return ["RELEASE", "COMPLETE"];
	if (state === "VIEWED" || state === "RECOMMENDED" || state === "NEW") return ["WATCH", "DISMISS"];
	return [];
}
function stateEvent(command) {
	return {
		WATCH: "已关注",
		UNWATCH: "已取消关注",
		ACCEPT: "已接单",
		DISMISS: "暂不考虑",
		RELEASE: "已释放",
		COMPLETE: "已完成"
	}[command];
}
function nextState(command) {
	return {
		WATCH: "WATCHED",
		UNWATCH: "VIEWED",
		ACCEPT: "ACCEPTED",
		DISMISS: "DISMISSED",
		RELEASE: "RELEASED",
		COMPLETE: "COMPLETED"
	}[command];
}
function DecisionWorkbench() {
	const [hydrated, setHydrated] = useState(false);
	const [page, setPage] = useState("today");
	const [navOpen, setNavOpen] = useState(true);
	const [sidebarWidth, setSidebarWidth] = useState(280);
	const [sidebarResize, setSidebarResize] = useState(null);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState("全部状态");
	const [sort, setSort] = useState("score");
	const [view, setView] = useState("list");
	const [selected, setSelected] = useState([]);
	const [detail, setDetail] = useState(null);
	const [clientDetail, setClientDetail] = useState(null);
	const [drawer, setDrawer] = useState(null);
	const [toast, setToast] = useState("");
	const [done, setDone] = useState([]);
	const [snoozed, setSnoozed] = useState([]);
	const [extraTasks, setExtraTasks] = useState([]);
	const [weights, setWeights] = useState([
		60,
		25,
		15
	]);
	const [eventType, setEventType] = useState("客户反馈");
	const [hc, setHc] = useState(3);
	const [panel, setPanel] = useState(null);
	const [decisionActions, setDecisionActions] = useState([]);
	const [engagement, setEngagement] = useState(initialEngagement);
	const [decisionEvents, setDecisionEvents] = useState(initialEvents);
	const [outcomes, setOutcomes] = useState(initialOutcomes);
	const [sync, setSync] = useState(seedSync);
	const [auth, setAuth] = useState(seedAuth);
	const [notifications, setNotifications] = useState(seedNotifications);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [mobileDrawerProgress, setMobileDrawerProgress] = useState(null);
	const mobileDrawerDrag = useRef(null);
	const mobileDrawerCloseTimer = useRef(null);
	const [pendingCommand, setPendingCommand] = useState(null);
	const [maintenanceOpen, setMaintenanceOpen] = useState(false);
	useEffect(() => {
		const savedState = readSavedWorkbenchState();
		setDone(savedState.done || []);
		setSnoozed(savedState.snoozed || []);
		setExtraTasks(savedState.extraTasks || []);
		setWeights(savedState.weights?.length === 3 ? savedState.weights : [
			60,
			25,
			15
		]);
		setDecisionActions(savedState.decisionActions || []);
		setSidebarWidth(savedState.sidebarWidth || 280);
		setEngagement({
			...initialEngagement,
			...savedState.engagement || {}
		});
		setDecisionEvents({
			...initialEvents,
			...savedState.events || {}
		});
		setOutcomes({
			...initialOutcomes,
			...savedState.outcomes || {}
		});
		setSync(savedState.sync || seedSync);
		setAuth(savedState.auth || seedAuth);
		setNotifications(savedState.notifications || seedNotifications);
		setHydrated(true);
	}, []);
	useEffect(() => {
		if (!hydrated) return;
		localStorage.setItem("decision-workbench", JSON.stringify({
			done,
			snoozed,
			extraTasks,
			weights,
			decisionActions,
			sidebarWidth,
			engagement,
			events: decisionEvents,
			outcomes,
			sync,
			auth,
			notifications
		}));
	}, [
		hydrated,
		done,
		snoozed,
		extraTasks,
		weights,
		decisionActions,
		sidebarWidth,
		engagement,
		decisionEvents,
		outcomes,
		sync,
		auth,
		notifications
	]);
	useEffect(() => {
		const closeOnEscape = (event) => {
			if (event.key !== "Escape") return;
			setPanel(null);
			setPendingCommand(null);
			setDrawer(null);
			setDetail(null);
			setClientDetail(null);
			setMobileNavOpen(false);
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, []);
	useEffect(() => {
		if (!sidebarResize) return;
		const delta = (event) => event.clientX - sidebarResize.startX;
		const rawWidth = (event) => sidebarResize.startWidth + delta(event);
		const move = (event) => {
			if (sidebarResize.opensCollapsed) {
				if (delta(event) < SIDEBAR_EXPAND_DISTANCE) return;
				setNavOpen(true);
				setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_WIDTH + delta(event) - SIDEBAR_EXPAND_DISTANCE)));
				return;
			}
			setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, rawWidth(event))));
		};
		const stop = (event) => {
			if (sidebarResize.opensCollapsed) {
				if (event.type === "pointerup" && delta(event) >= SIDEBAR_EXPAND_DISTANCE) setNavOpen(true);
				setSidebarResize(null);
				return;
			}
			if (event.type === "pointerup" && rawWidth(event) < SIDEBAR_MIN_WIDTH - SIDEBAR_COLLAPSE_DISTANCE) setNavOpen(false);
			setSidebarResize(null);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
		};
	}, [sidebarResize]);
	const notify = (s) => {
		setToast(s);
		setTimeout(() => setToast(""), 2200);
	};
	const filteredJobs = useMemo(() => jobs.filter((j) => (status === "全部状态" || j.status === status) && `${j.name}${j.client}${j.city}`.includes(query)).sort((a, b) => sort === "score" ? b.score - a.score : b.hc - a.hc), [
		query,
		status,
		sort
	]);
	actionSeed.map((a, i) => ({
		a,
		i
	})).filter((x) => !done.includes(x.i) && !snoozed.includes(x.i));
	const go = (p) => {
		setPage(p);
		setDetail(null);
		setClientDetail(null);
		setPanel(null);
		setDrawer(null);
		setMobileNavOpen(false);
	};
	const runDecisionAction = (job, action) => {
		setDecisionActions((v) => v.includes(`${job.id}:${action.id}`) ? v : [...v, `${job.id}:${action.id}`]);
		notify(`已记录：${action.label}`);
	};
	const openDecision = (job, tab = "judgement") => setPanel((current) => current?.kind === "job" && current.jobId === job.id && current.tab === tab ? null : {
		kind: "job",
		jobId: job.id,
		tab
	});
	const applyCommand = (job, command, reason) => {
		const state = nextState(command);
		setEngagement((current) => ({
			...current,
			[job.id]: state
		}));
		setDecisionEvents((current) => ({
			...current,
			[job.id]: [{
				id: `evt-${Date.now()}`,
				type: stateEvent(command),
				at: (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", {
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit"
				}),
				reason
			}, ...current[job.id] || []]
		}));
		setPendingCommand(null);
		notify(`${job.company} · ${stateEvent(command)}`);
	};
	const requestCommand = (job, command) => {
		if (command === "ACCEPT" || command === "DISMISS") {
			setPendingCommand({
				job,
				command
			});
			return;
		}
		applyCommand(job, command);
	};
	const recordOutcome = (job, stage, rating, note) => {
		const item = {
			id: `out-${Date.now()}`,
			stage,
			rating,
			note,
			at: (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit"
			})
		};
		setOutcomes((current) => ({
			...current,
			[job.id]: [item, ...current[job.id] || []]
		}));
		setDecisionEvents((current) => ({
			...current,
			[job.id]: [{
				id: `evt-${Date.now()}`,
				type: "记录结果",
				at: item.at,
				reason: stage
			}, ...current[job.id] || []]
		}));
		notify(`已记录${stage}`);
	};
	const runSync = () => {
		setSync((current) => ({
			...current,
			state: "RUNNING",
			errors: []
		}));
		notify("正在生成演示快照…");
		window.setTimeout(() => {
			setSync({
				...seedSync,
				updatedAt: (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", {
					hour: "2-digit",
					minute: "2-digit"
				})
			});
			notify("快照已更新，推荐已刷新");
		}, 650);
	};
	const openNotification = (item) => {
		setNotifications((current) => current.map((note) => note.id === item.id ? {
			...note,
			read: true
		} : note));
		if (item.jobId) {
			const job = decisionJobs.find((entry) => entry.id === item.jobId);
			if (job) openDecision(job, item.kind === "DAILY_TOP3" ? "replay" : "engagement");
		} else setPanel({ kind: "sync" });
	};
	const startSidebarResize = (event) => {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		const opensCollapsed = !navOpen;
		setSidebarResize({
			startX: event.clientX,
			startWidth: opensCollapsed ? SIDEBAR_MIN_WIDTH : sidebarWidth,
			opensCollapsed
		});
	};
	const resizeFromKeyboard = (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		if (!navOpen && event.key === "ArrowRight") {
			setSidebarWidth(SIDEBAR_MIN_WIDTH);
			setNavOpen(true);
			return;
		}
		setSidebarWidth((width) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width + (event.key === "ArrowRight" ? 16 : -16))));
	};
	const selectedDecisionJob = panel?.kind === "job" ? [...decisionJobs, ...verificationJobs].find((job) => job.id === panel.jobId) || null : null;
	const commitmentJobs = decisionJobs.filter((job) => ["WATCHED", "ACCEPTED"].includes(engagement[job.id] || "NEW"));
	const panelOpen = !!panel;
	const clearMobileDrawerCloseTimer = () => {
		if (mobileDrawerCloseTimer.current !== null) {
			window.clearTimeout(mobileDrawerCloseTimer.current);
			mobileDrawerCloseTimer.current = null;
		}
	};
	const closeMobileDrawer = (animate = true) => {
		clearMobileDrawerCloseTimer();
		if (!animate) {
			setMobileDrawerProgress(null);
			setMobileNavOpen(false);
			return;
		}
		setMobileDrawerProgress(0);
		mobileDrawerCloseTimer.current = window.setTimeout(() => {
			setMobileNavOpen(false);
			setMobileDrawerProgress(null);
			mobileDrawerCloseTimer.current = null;
		}, 230);
	};
	const toggleMobileDrawer = () => {
		if (mobileNavOpen) {
			closeMobileDrawer();
			return;
		}
		clearMobileDrawerCloseTimer();
		setMobileNavOpen(true);
		setMobileDrawerProgress(0);
		window.requestAnimationFrame(() => setMobileDrawerProgress(null));
	};
	const beginMobileSwipe = (event) => {
		if (typeof window === "undefined" || window.innerWidth > 720 || event.button !== 0 || mobileNavOpen) return;
		if (event.target.closest("button,a,input,select,textarea")) return;
		if (event.clientX > 28) return;
		clearMobileDrawerCloseTimer();
		const drawerWidth = Math.min(window.innerWidth * .82, 320);
		mobileDrawerDrag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startProgress: 0,
			drawerWidth,
			lastX: event.clientX,
			lastAt: event.timeStamp,
			velocity: 0,
			progress: 0,
			moved: false
		};
		if (!mobileNavOpen) setMobileNavOpen(true);
		setMobileDrawerProgress(0);
	};
	const moveMobileSwipe = (event) => {
		const drag = mobileDrawerDrag.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const distance = Math.abs(event.clientX - drag.startX);
		if (!drag.moved && distance < 8) return;
		if (!drag.moved) {
			drag.moved = true;
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		const raw = drag.startProgress + (event.clientX - drag.startX) / drag.drawerWidth;
		const elapsed = event.timeStamp - drag.lastAt;
		if (elapsed > 0) drag.velocity = (event.clientX - drag.lastX) / elapsed;
		drag.lastX = event.clientX;
		drag.lastAt = event.timeStamp;
		drag.progress = raw < 0 ? raw * .24 : raw > 1 ? 1 + (raw - 1) * .24 : raw;
		setMobileDrawerProgress(drag.progress);
	};
	const endMobileSwipe = (event, cancelled = false) => {
		const drag = mobileDrawerDrag.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		const velocityProgress = drag.velocity / drag.drawerWidth;
		const momentum = cancelled ? 0 : Math.max(-.35, Math.min(.35, velocityProgress * 140));
		if (Math.min(1, Math.max(0, drag.progress + momentum)) >= .5) {
			setMobileNavOpen(true);
			setMobileDrawerProgress(1);
			window.setTimeout(() => setMobileDrawerProgress(null), 230);
		} else closeMobileDrawer();
		mobileDrawerDrag.current = null;
	};
	return /* @__PURE__ */ jsxs("div", {
		className: `app btex-app ${navOpen ? "nav-open" : ""} ${panelOpen ? "decision-panel-open" : ""} ${sidebarResize ? "is-resizing" : ""} ${mobileNavOpen ? "mobile-nav-open" : ""} ${mobileDrawerDrag.current ? "mobile-nav-swiping" : ""}`,
		style: {
			"--sidebar-width": `${navOpen ? sidebarWidth : 68}px`,
			"--mobile-drawer-progress": mobileDrawerProgress ?? 1
		},
		onPointerDown: beginMobileSwipe,
		onPointerMove: moveMobileSwipe,
		onPointerUp: (event) => endMobileSwipe(event),
		onPointerCancel: (event) => endMobileSwipe(event, true),
		children: [
			/* @__PURE__ */ jsxs("aside", {
				className: "sidebar btex-nav",
				"aria-label": "主要导航",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "brand",
						children: [/* @__PURE__ */ jsxs("div", {
							className: "brand-identity",
							children: [/* @__PURE__ */ jsx("div", {
								className: "brand-mark",
								"aria-label": "B-tex",
								children: /* @__PURE__ */ jsx(Infinity$1, { "aria-hidden": "true" })
							}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: "B-tex" }), /* @__PURE__ */ jsx("small", { children: "职位决策台" })] })]
						}), /* @__PURE__ */ jsx("button", {
							className: "nav-toggle",
							onClick: () => setNavOpen((v) => !v),
							"aria-label": navOpen ? "收起导航" : "展开导航",
							children: navOpen ? /* @__PURE__ */ jsx(PanelLeftClose, {}) : /* @__PURE__ */ jsx(PanelLeftOpen, {})
						})]
					}),
					/* @__PURE__ */ jsxs("button", {
						className: "mobile-nav-trigger",
						onClick: toggleMobileDrawer,
						"aria-label": mobileNavOpen ? "收起全部模块" : "打开全部模块",
						"aria-expanded": mobileNavOpen,
						children: [/* @__PURE__ */ jsx(Infinity$1, { "aria-hidden": "true" }), /* @__PURE__ */ jsx("span", { children: mobileNavOpen ? "收起模块" : "全部模块" })]
					}),
					/* @__PURE__ */ jsx("nav", {
						className: "nav",
						children: nav.map(([id, label, Icon]) => /* @__PURE__ */ jsxs("button", {
							className: page === id ? "active" : "",
							onClick: () => go(id),
							children: [/* @__PURE__ */ jsx(Icon, {}), /* @__PURE__ */ jsx("span", { children: label })]
						}, id))
					}),
					/* @__PURE__ */ jsx(SidebarCommitments, {
						jobs: commitmentJobs,
						engagement,
						onOpen: (job) => openDecision(job, "engagement"),
						onExpand: () => setNavOpen(true)
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "sidebar-foot",
						children: [/* @__PURE__ */ jsxs("div", {
							className: "ai-status",
							children: [/* @__PURE__ */ jsx("i", { className: "pulse" }), /* @__PURE__ */ jsx("span", { children: "快照已同步" })]
						}), /* @__PURE__ */ jsx("small", { children: "Policy v1.2" })]
					}),
					/* @__PURE__ */ jsx("div", {
						className: "sidebar-resizer",
						role: "separator",
						"aria-label": "调整侧栏宽度",
						"aria-orientation": "vertical",
						"aria-valuemin": SIDEBAR_MIN_WIDTH,
						"aria-valuemax": SIDEBAR_MAX_WIDTH,
						"aria-valuenow": navOpen ? sidebarWidth : 68,
						tabIndex: 0,
						onPointerDown: startSidebarResize,
						onKeyDown: resizeFromKeyboard
					})
				]
			}),
			mobileNavOpen && /* @__PURE__ */ jsx("button", {
				className: "mobile-nav-backdrop",
				onClick: () => closeMobileDrawer(),
				"aria-label": "关闭全部模块"
			}),
			/* @__PURE__ */ jsxs("main", {
				className: "main",
				children: [/* @__PURE__ */ jsx("header", {
					className: "topbar",
					children: page === "today" ? /* @__PURE__ */ jsxs(Fragment, { children: [
						/* @__PURE__ */ jsxs("button", {
							className: "btex-person identity-trigger",
							onClick: () => setPanel({ kind: "identity" }),
							children: [/* @__PURE__ */ jsx(CircleUserRound, {}), auth.consultant]
						}),
						/* @__PURE__ */ jsxs("button", {
							className: `sync sync-trigger ${auth.needsReauth ? "auth_expired" : sync.state.toLowerCase()}`,
							onClick: () => setPanel(auth.needsReauth ? { kind: "identity" } : { kind: "sync" }),
							children: [
								/* @__PURE__ */ jsx("i", {}),
								" ",
								auth.needsReauth ? "飞书授权已过期" : sync.state === "READY" ? `Snapshot #1842 · ${sync.updatedAt} 已同步` : sync.state === "RUNNING" ? "同步中…" : sync.state === "INCOMPLETE" ? "本次同步不完整" : sync.state === "AUTH_EXPIRED" ? "飞书授权已过期" : sync.state === "ERROR" ? "同步失败" : "尚未同步"
							]
						}),
						/* @__PURE__ */ jsxs("button", {
							className: "mobile-commitment-trigger",
							onClick: () => setPanel({ kind: "commitments" }),
							"aria-label": `我的承接 ${commitmentJobs.length} 个`,
							children: [/* @__PURE__ */ jsx(BriefcaseBusiness, {}), /* @__PURE__ */ jsx("i", { children: commitmentJobs.length })]
						}),
						/* @__PURE__ */ jsxs("button", {
							className: "icon-btn notification-trigger",
							onClick: () => setPanel({ kind: "notifications" }),
							"aria-label": "今日提醒",
							children: [/* @__PURE__ */ jsx(BellRing, {}), notifications.filter((note) => !note.read).length > 0 && /* @__PURE__ */ jsx("i", { children: notifications.filter((note) => !note.read).length })]
						}),
						/* @__PURE__ */ jsxs("button", {
							className: "top-pill",
							onClick: () => setNavOpen(true),
							children: ["全部模块 ", /* @__PURE__ */ jsx(ChevronRight, {})]
						})
					] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
						/* @__PURE__ */ jsxs("div", {
							className: "search",
							children: [/* @__PURE__ */ jsx(Search, {}), /* @__PURE__ */ jsx("input", {
								value: query,
								onChange: (e) => setQuery(e.target.value),
								placeholder: "搜索客户、职位、PM…"
							})]
						}),
						/* @__PURE__ */ jsxs("button", {
							className: "top-pill",
							onClick: () => notify("全局筛选已展开"),
							children: [
								/* @__PURE__ */ jsx(Filter, {}),
								" 当前团队 ",
								/* @__PURE__ */ jsx(ChevronRight, {})
							]
						}),
						/* @__PURE__ */ jsx("span", {
							className: "sync",
							children: "更新于 14:32 · 7个来源"
						}),
						/* @__PURE__ */ jsx("button", {
							className: "icon-btn",
							onClick: () => setPanel({ kind: "notifications" }),
							"aria-label": "通知",
							children: /* @__PURE__ */ jsx(Bell, {})
						})
					] })
				}), /* @__PURE__ */ jsx("div", {
					className: "content",
					children: detail ? /* @__PURE__ */ jsx(JobDetail, {
						job: detail,
						onBack: () => setDetail(null),
						weights,
						eventType,
						setEventType,
						hc,
						setHc,
						notify
					}) : clientDetail ? /* @__PURE__ */ jsx(ClientDetail, {
						c: clientDetail,
						onBack: () => setClientDetail(null),
						notify
					}) : /* @__PURE__ */ jsxs(Fragment, { children: [
						page === "today" && /* @__PURE__ */ jsx(DecisionToday, {
							maintenanceOpen,
							setMaintenanceOpen,
							completed: decisionActions,
							jobs: decisionJobs,
							engagement,
							sync,
							open: openDecision,
							onRules: () => go("rules"),
							onAction: runDecisionAction
						}),
						page === "jobs" && /* @__PURE__ */ jsx(JobsView, {
							jobs: filteredJobs,
							status,
							setStatus,
							sort,
							setSort,
							view,
							setView,
							selected,
							setSelected,
							openJob: setDetail,
							notify
						}),
						page === "clients" && /* @__PURE__ */ jsx(ClientsView, {
							clients: clients.filter((c) => `${c.name}${c.industry}`.includes(query)),
							open: setClientDetail,
							notify
						}),
						page === "alerts" && /* @__PURE__ */ jsx(Alerts, {
							setExtraTasks,
							notify,
							setDrawer
						}),
						page === "rules" && /* @__PURE__ */ jsx(Rules, {
							weights,
							setWeights,
							notify
						}),
						page === "sources" && /* @__PURE__ */ jsx(Sources, { notify })
					] })
				})]
			}),
			panel && /* @__PURE__ */ jsx(WorkbenchPanel, {
				panel,
				job: selectedDecisionJob,
				commitmentJobs,
				auth,
				sync,
				notifications,
				engagement,
				events: decisionEvents,
				outcomes,
				completed: decisionActions,
				onClose: () => setPanel(null),
				onOpenJob: openDecision,
				onAction: runDecisionAction,
				onCommand: requestCommand,
				onOutcome: recordOutcome,
				onSync: runSync,
				onSetSync: setSync,
				onAuth: setAuth,
				onNotification: openNotification,
				notify
			}),
			pendingCommand && /* @__PURE__ */ jsx(CommandConfirm, {
				pending: pendingCommand,
				onClose: () => setPendingCommand(null),
				onConfirm: (reason) => applyCommand(pendingCommand.job, pendingCommand.command, reason)
			}),
			drawer && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
				className: "drawer-backdrop",
				onClick: () => setDrawer(null)
			}), /* @__PURE__ */ jsxs("aside", {
				className: "drawer",
				children: [
					/* @__PURE__ */ jsx("button", {
						className: "icon-btn",
						style: { float: "right" },
						onClick: () => setDrawer(null),
						children: /* @__PURE__ */ jsx(X, {})
					}),
					/* @__PURE__ */ jsx("span", {
						className: "eyebrow",
						children: "Decision evidence"
					}),
					/* @__PURE__ */ jsx("h2", { children: "判断依据" }),
					/* @__PURE__ */ jsxs("div", {
						className: "conclusion",
						children: [/* @__PURE__ */ jsx("div", {
							className: "spark",
							children: /* @__PURE__ */ jsx(Sparkles, {})
						}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: drawer }), /* @__PURE__ */ jsx("p", { children: "综合规则计算与AI结构化推断，置信度 91%" })] })]
					}),
					/* @__PURE__ */ jsx("div", {
						className: "score-bars",
						children: [
							"客户招聘意愿 18/20",
							"职位新鲜度 14/15",
							"HC与紧急程度 15/15",
							"客户反馈速度 14/15",
							"转化表现 16/20",
							"竞争与风险 12/15"
						].map((x, i) => /* @__PURE__ */ jsxs("div", {
							className: "mini-item",
							children: [/* @__PURE__ */ jsxs("span", {
								className: "num",
								children: ["0", i + 1]
							}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: x }), /* @__PURE__ */ jsx("p", { children: i < 4 ? "规则计算 · 内部项目驾驶舱" : "AI推断 · 基于近30天事件" })] })]
						}, x))
					}),
					/* @__PURE__ */ jsx("button", {
						className: "btn primary",
						style: { marginTop: 18 },
						onClick: () => {
							setDrawer(null);
							notify("依据已复制到项目备注");
						},
						children: "复制到项目备注"
					})
				]
			})] }),
			toast && /* @__PURE__ */ jsxs("div", {
				className: "toast",
				children: [
					/* @__PURE__ */ jsx(Check, {}),
					" ",
					toast
				]
			})
		]
	});
}
function SidebarCommitments({ jobs, engagement, onOpen, onExpand }) {
	const accepted = jobs.filter((job) => engagement[job.id] === "ACCEPTED").length;
	const watched = jobs.filter((job) => engagement[job.id] === "WATCHED").length;
	return /* @__PURE__ */ jsxs("section", {
		className: "sidebar-commitments",
		"aria-label": "我的承接",
		children: [/* @__PURE__ */ jsxs("button", {
			className: "commitment-rail-toggle",
			onClick: onExpand,
			"aria-label": `展开我的承接，${jobs.length} 个`,
			children: [/* @__PURE__ */ jsx(BriefcaseBusiness, {}), /* @__PURE__ */ jsx("i", { children: jobs.length })]
		}), /* @__PURE__ */ jsxs("div", {
			className: "commitment-rail-body",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "commitment-rail-head",
					children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: "我的承接" }), /* @__PURE__ */ jsx("small", { children: "持续工作区" })] }), /* @__PURE__ */ jsx("em", { children: jobs.length })]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "commitment-rail-counts",
					children: [/* @__PURE__ */ jsxs("span", { children: [
						/* @__PURE__ */ jsx("i", { className: "accepted" }),
						accepted,
						" 接单中"
					] }), /* @__PURE__ */ jsxs("span", { children: [
						/* @__PURE__ */ jsx("i", { className: "watched" }),
						watched,
						" 关注中"
					] })]
				}),
				jobs.length ? /* @__PURE__ */ jsx("div", {
					className: "commitment-rail-list",
					children: jobs.map((job) => /* @__PURE__ */ jsxs("button", {
						onClick: () => onOpen(job),
						className: engagement[job.id] === "ACCEPTED" ? "accepted" : "watched",
						children: [
							/* @__PURE__ */ jsx("i", {}),
							/* @__PURE__ */ jsxs("span", { children: [
								/* @__PURE__ */ jsx("b", { children: job.company }),
								/* @__PURE__ */ jsx("small", { children: job.role }),
								/* @__PURE__ */ jsx("em", { children: engagement[job.id] === "ACCEPTED" ? "推进或记录结果" : "评估是否接单" })
							] }),
							/* @__PURE__ */ jsx(ChevronRight, {})
						]
					}, job.id))
				}) : /* @__PURE__ */ jsx("p", {
					className: "commitment-rail-empty",
					children: "还没有关注或接单的职位。"
				})
			]
		})]
	});
}
function Heading({ code, title, desc, action }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "headline",
		children: [/* @__PURE__ */ jsxs("div", { children: [
			/* @__PURE__ */ jsx("span", {
				className: "eyebrow",
				children: code
			}),
			/* @__PURE__ */ jsx("h1", { children: title }),
			/* @__PURE__ */ jsx("p", { children: desc })
		] }), action]
	});
}
function StatusTag({ s }) {
	return /* @__PURE__ */ jsx("span", {
		className: `tag ${s.includes("关闭") || s.includes("风险") || s.includes("异常") ? "red" : s === "拥挤" || s === "降温" ? "gray" : "blue"}`,
		children: s
	});
}
function FilterSelect({ value, options, onChange, ariaLabel }) {
	const [open, setOpen] = useState(false);
	const root = useRef(null);
	const selected = options.find((option) => option.value === value) ?? options[0];
	useEffect(() => {
		if (!open) return;
		const close = (event) => {
			if (!root.current?.contains(event.target)) setOpen(false);
		};
		const onKey = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return /* @__PURE__ */ jsxs("div", {
		className: `filter-select${open ? " is-open" : ""}`,
		ref: root,
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "field filter-select-trigger",
			"aria-label": ariaLabel,
			"aria-haspopup": "listbox",
			"aria-expanded": open,
			onClick: () => setOpen((value) => !value),
			onKeyDown: (event) => {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					setOpen(true);
				}
			},
			children: [/* @__PURE__ */ jsx("span", { children: selected.label }), /* @__PURE__ */ jsx(ChevronDown, {})]
		}), open && /* @__PURE__ */ jsx("div", {
			className: "filter-select-menu",
			role: "listbox",
			"aria-label": ariaLabel,
			children: options.map((option) => /* @__PURE__ */ jsx("button", {
				type: "button",
				role: "option",
				"aria-selected": option.value === value,
				className: option.value === value ? "selected" : "",
				onClick: () => {
					onChange(option.value);
					setOpen(false);
				},
				children: option.label
			}, option.value))
		})]
	});
}
function DirectGlassSegment({ value, options, onChange, className = "", ariaLabel }) {
	const [dragProgress, setDragProgress] = useState(null);
	const drag = useRef(null);
	const index = Math.max(0, options.findIndex((option) => option.value === value));
	const progress = dragProgress ?? index;
	const rubberBand = (raw) => Math.min(options.length - 1, Math.max(0, raw));
	const start = (event) => {
		if (event.button !== 0) return;
		const rect = event.currentTarget.getBoundingClientRect();
		drag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startIndex: index,
			trackWidth: Math.max(1, rect.width - 8),
			lastX: event.clientX,
			lastAt: event.timeStamp,
			velocity: 0,
			progress: index,
			moved: false
		};
	};
	const move = (event) => {
		const active = drag.current;
		if (!active || active.pointerId !== event.pointerId) return;
		const distance = Math.abs(event.clientX - active.startX);
		if (!active.moved && distance < 8) return;
		if (!active.moved) {
			active.moved = true;
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		const raw = active.startIndex + (event.clientX - active.startX) / (active.trackWidth / options.length);
		const elapsed = event.timeStamp - active.lastAt;
		if (elapsed > 0) active.velocity = (event.clientX - active.lastX) / elapsed;
		active.lastX = event.clientX;
		active.lastAt = event.timeStamp;
		active.progress = rubberBand(raw);
		setDragProgress(active.progress);
	};
	const finish = (event, cancelled = false) => {
		const active = drag.current;
		if (!active || active.pointerId !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		if (!cancelled && active.moved) {
			const velocityInSteps = active.velocity / (active.trackWidth / options.length);
			const projected = Math.min(options.length - 1, Math.max(0, active.progress + Math.max(-.5, Math.min(.5, velocityInSteps * 140))));
			onChange(options[Math.round(projected)].value);
		}
		drag.current = null;
		setDragProgress(null);
	};
	return /* @__PURE__ */ jsxs("nav", {
		className: `direct-segment ${className}${dragProgress !== null ? " is-dragging" : ""}`,
		"aria-label": ariaLabel,
		style: {
			"--direct-index": progress,
			"--direct-count": options.length
		},
		onPointerDown: start,
		onPointerMove: move,
		onPointerUp: (event) => finish(event),
		onPointerCancel: (event) => finish(event, true),
		children: [/* @__PURE__ */ jsx("span", {
			className: "direct-segment-lens",
			"aria-hidden": "true"
		}), options.map((option) => /* @__PURE__ */ jsx("button", {
			className: value === option.value ? "active" : "",
			onClick: () => onChange(option.value),
			"aria-label": option.ariaLabel,
			children: option.label
		}, option.value))]
	});
}
function DecisionToday({ maintenanceOpen, setMaintenanceOpen, completed, jobs, engagement, sync, open, onRules, onAction }) {
	const [direction, setDirection] = useState("paid");
	const [directionDragProgress, setDirectionDragProgress] = useState(null);
	const directionDrag = useRef(null);
	const suppressDirectionClick = useRef(false);
	const directionMeta = {
		paid: {
			label: "投放",
			description: "广告投放与优化"
		},
		growth: {
			label: "增长负责人",
			description: "增长、GTM 与商业化"
		},
		marketing: {
			label: "市场负责人",
			description: "市场、品牌与公关"
		}
	};
	const directions = Object.keys(directionMeta);
	const directionIndex = directions.indexOf(direction);
	const lensProgress = directionDragProgress ?? directionIndex;
	const clampDirectionProgress = (value) => Math.min(directions.length - 1, Math.max(0, value));
	const rubberBandDirectionProgress = (value) => value < 0 ? value * .28 : value > directions.length - 1 ? directions.length - 1 + (value - (directions.length - 1)) * .28 : value;
	const beginDirectionDrag = (event) => {
		if (event.button !== 0) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const trackWidth = Math.max(1, rect.width - 8);
		directionDrag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startProgress: directionIndex,
			trackWidth,
			lastX: event.clientX,
			lastAt: event.timeStamp,
			velocity: 0,
			progress: directionIndex,
			moved: false
		};
	};
	const moveDirectionDrag = (event) => {
		const drag = directionDrag.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const distance = Math.abs(event.clientX - drag.startX);
		if (!drag.moved && distance < 8) return;
		if (!drag.moved) {
			drag.moved = true;
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		const step = drag.trackWidth / directions.length;
		const rawProgress = drag.startProgress + (event.clientX - drag.startX) / step;
		const elapsed = event.timeStamp - drag.lastAt;
		if (elapsed > 0) drag.velocity = (event.clientX - drag.lastX) / elapsed;
		drag.lastX = event.clientX;
		drag.lastAt = event.timeStamp;
		drag.progress = rubberBandDirectionProgress(rawProgress);
		setDirectionDragProgress(drag.progress);
	};
	const finishDirectionDrag = (event, cancelled = false) => {
		const drag = directionDrag.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		if (!cancelled && drag.moved) {
			const velocityInSteps = drag.velocity / (drag.trackWidth / directions.length);
			const projected = clampDirectionProgress(drag.progress + Math.max(-.5, Math.min(.5, velocityInSteps * 140)));
			setDirection(directions[Math.round(projected)]);
			suppressDirectionClick.current = true;
			window.setTimeout(() => {
				suppressDirectionClick.current = false;
			}, 0);
		}
		directionDrag.current = null;
		setDirectionDragProgress(null);
	};
	const visible = jobs.filter((job) => job.direction === direction).sort((a, b) => a.rank - b.rank).slice(0, 3);
	const directionVerification = verificationJobs.filter((job) => job.direction === direction);
	const commitments = jobs.filter((job) => ["WATCHED", "ACCEPTED"].includes(engagement[job.id] || "NEW"));
	return /* @__PURE__ */ jsxs("div", {
		className: "decision-home",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "decision-heading",
				children: [/* @__PURE__ */ jsxs("div", { children: [
					/* @__PURE__ */ jsx("span", {
						className: "decision-kicker",
						children: "今日职位决策"
					}),
					/* @__PURE__ */ jsx("h1", { children: "今天先做这 3 个职位" }),
					/* @__PURE__ */ jsxs("p", { children: [
						/* @__PURE__ */ jsxs("strong", { children: [jobs.length, " 个有效机会"] }),
						/* @__PURE__ */ jsx("span", { children: "·" }),
						/* @__PURE__ */ jsxs("strong", {
							className: "warn",
							children: [verificationJobs.length, " 个待核验"]
						}),
						/* @__PURE__ */ jsx("span", { children: "·" }),
						/* @__PURE__ */ jsxs("strong", { children: [commitments.length, " 个承接中"] })
					] })
				] }), /* @__PURE__ */ jsxs("button", {
					className: "link decision-link",
					onClick: onRules,
					children: ["判断策略 ", /* @__PURE__ */ jsx(SlidersHorizontal, {})]
				})]
			}),
			/* @__PURE__ */ jsxs("nav", {
				className: `direction-tabs${directionDragProgress !== null ? " is-dragging" : ""}`,
				"aria-label": "职位方向",
				style: { "--direction-index": lensProgress },
				onPointerDown: beginDirectionDrag,
				onPointerMove: moveDirectionDrag,
				onPointerUp: (event) => finishDirectionDrag(event),
				onPointerCancel: (event) => finishDirectionDrag(event, true),
				children: [/* @__PURE__ */ jsx("span", {
					className: "direction-glass-lens",
					"aria-hidden": "true"
				}), directions.map((key) => /* @__PURE__ */ jsxs("button", {
					"data-direction": key,
					className: direction === key ? "active" : "",
					onClick: (event) => {
						if (suppressDirectionClick.current) {
							event.preventDefault();
							return;
						}
						setDirection(key);
					},
					children: [/* @__PURE__ */ jsx("b", { children: directionMeta[key].label }), /* @__PURE__ */ jsx("small", { children: directionMeta[key].description })]
				}, key))]
			}),
			sync.state === "INCOMPLETE" || sync.state === "ERROR" ? /* @__PURE__ */ jsxs("section", {
				className: "decision-blocked",
				children: [
					/* @__PURE__ */ jsx(TriangleAlert, {}),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: sync.state === "INCOMPLETE" ? "本次同步不完整" : "同步失败" }), /* @__PURE__ */ jsx("p", { children: "为避免误导，当前不展示新的正式推荐。" })] }),
					/* @__PURE__ */ jsx("button", {
						className: "btn",
						onClick: () => open(jobs[0], "judgement"),
						children: "查看上次快照"
					})
				]
			}) : /* @__PURE__ */ jsxs("section", {
				className: "decision-lane",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "decision-group-head",
					children: [/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsxs("h2", { children: [directionMeta[direction].label, " Top 3"] }), /* @__PURE__ */ jsx("p", { children: "Agent 已先处理 HC、关闭、入职和项目重复，再按推进、探索与个人适配排序" })] }), /* @__PURE__ */ jsx("span", { children: "Snapshot 08.11" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "decision-queue",
					children: visible.map((job) => /* @__PURE__ */ jsx(DecisionRow, {
						job,
						completed,
						engagement: engagement[job.id] || "NEW",
						open,
						onAction
					}, job.id))
				})]
			}),
			/* @__PURE__ */ jsxs("section", {
				className: "decision-collapsed verification-pool",
				children: [/* @__PURE__ */ jsxs("button", {
					onClick: () => setMaintenanceOpen(!maintenanceOpen),
					children: [
						/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: "需要先确认" }), /* @__PURE__ */ jsx("small", { children: "Offer、入职或剩余 HC 不确定，不占用正式 Top 3" })] }),
						/* @__PURE__ */ jsxs("em", { children: [directionVerification.length, " 个"] }),
						/* @__PURE__ */ jsx(ChevronRight, { className: maintenanceOpen ? "turned" : "" })
					]
				}), maintenanceOpen && /* @__PURE__ */ jsx("div", {
					className: "verification-list",
					children: directionVerification.length ? directionVerification.map((job) => /* @__PURE__ */ jsx(VerificationRow, {
						job,
						open,
						onAction
					}, job.id)) : /* @__PURE__ */ jsx("p", { children: "当前方向没有待核验职位。" })
				})]
			})
		]
	});
}
function VerificationRow({ job, open, onAction }) {
	const action = job.actions[0];
	return /* @__PURE__ */ jsxs("article", {
		className: "verification-row",
		children: [/* @__PURE__ */ jsxs("button", {
			className: "verification-main",
			onClick: () => open(job),
			children: [/* @__PURE__ */ jsx(TriangleAlert, {}), /* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsxs("b", { children: [
				job.company,
				" · ",
				job.role
			] }), /* @__PURE__ */ jsx("small", { children: job.recentSignal })] })]
		}), /* @__PURE__ */ jsxs("button", {
			className: "link",
			onClick: () => onAction(job, action),
			children: [action.label, /* @__PURE__ */ jsx(ChevronRight, {})]
		})]
	});
}
function DecisionRow({ job, completed, engagement, open, onAction }) {
	const action = job.actions.find((item) => !completed.includes(`${job.id}:${item.id}`)) || job.actions[0];
	const actionComplete = completed.includes(`${job.id}:${action.id}`);
	return /* @__PURE__ */ jsxs("article", {
		className: "decision-row",
		children: [
			/* @__PURE__ */ jsx("button", {
				className: "decision-row-toggle",
				onClick: () => open(job),
				"aria-label": `打开或关闭 ${job.company} 详情`
			}),
			/* @__PURE__ */ jsx("div", {
				className: "decision-rank",
				children: String(job.rank).padStart(2, "0")
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "decision-title",
				children: [
					/* @__PURE__ */ jsxs("b", { children: [
						job.company,
						" ",
						/* @__PURE__ */ jsx("span", { children: "·" }),
						" ",
						job.role
					] }),
					/* @__PURE__ */ jsxs("div", {
						className: "decision-labels",
						children: [
							/* @__PURE__ */ jsx("em", { children: decisionGroupMeta[job.group].title }),
							/* @__PURE__ */ jsx("em", { children: job.facts["职位关系"] }),
							/* @__PURE__ */ jsx("em", {
								className: job.sourceMode === "COCKPIT_CONTEXT" ? "cockpit" : "market",
								children: job.sourceMode === "COCKPIT_CONTEXT" ? "驾驶舱上下文" : "职位市场"
							}),
							/* @__PURE__ */ jsx("em", {
								className: "row-state",
								children: stateLabel[engagement]
							})
						]
					}),
					/* @__PURE__ */ jsx("small", { children: job.recommendation })
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "decision-scores",
				children: [
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "推进",
						value: job.globalScore
					}),
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "探索",
						value: job.explorationScore
					}),
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "个人",
						value: job.personalScore
					}),
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "最终",
						value: job.finalScore,
						emphasis: "final"
					})
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "decision-action",
				children: [/* @__PURE__ */ jsx("small", { children: job.recentSignal }), /* @__PURE__ */ jsxs("button", {
					className: actionComplete ? "complete" : "",
					onClick: () => onAction(job, action),
					disabled: actionComplete,
					children: [actionComplete ? "已记录" : action.label, /* @__PURE__ */ jsx(ChevronRight, {})]
				})]
			}),
			/* @__PURE__ */ jsx("span", {
				className: "row-disclosure",
				"aria-hidden": "true",
				children: /* @__PURE__ */ jsx(ChevronRight, {})
			})
		]
	});
}
function DecisionMetric({ label, value, emphasis, helpOpen, onHelpToggle }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "decision-metric",
		children: [
			/* @__PURE__ */ jsx("small", { children: label }),
			onHelpToggle && /* @__PURE__ */ jsx("button", {
				className: "metric-help",
				type: "button",
				onClick: onHelpToggle,
				"aria-label": `解释${label}`,
				"aria-expanded": helpOpen,
				children: "!"
			}),
			/* @__PURE__ */ jsx("b", {
				className: emphasis,
				children: value
			})
		]
	});
}
function WorkbenchPanel({ panel, job, commitmentJobs, auth, sync, notifications, engagement, events, outcomes, completed, onClose, onOpenJob, onAction, onCommand, onOutcome, onSync, onSetSync, onAuth, onNotification, notify }) {
	const [dragOffset, setDragOffset] = useState(null);
	const panelDrag = useRef(null);
	const startPanelDrag = (event) => {
		if (typeof window === "undefined" || window.innerWidth > 720 || event.button !== 0) return;
		panelDrag.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			lastX: event.clientX,
			lastAt: performance.now(),
			velocity: 0
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragOffset(0);
	};
	const movePanelDrag = (event) => {
		const drag = panelDrag.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		const now = performance.now();
		const raw = Math.max(0, event.clientX - drag.startX);
		const offset = raw > 260 ? 260 + (raw - 260) * .28 : raw;
		drag.velocity = (event.clientX - drag.lastX) / Math.max(1, now - drag.lastAt);
		drag.lastX = event.clientX;
		drag.lastAt = now;
		setDragOffset(offset);
	};
	const finishPanelDrag = (event) => {
		const drag = panelDrag.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		panelDrag.current = null;
		const projected = Math.max(0, event.clientX - drag.startX) + Math.max(0, drag.velocity) * 150;
		setDragOffset(null);
		if (projected > window.innerWidth * .3) onClose();
	};
	return /* @__PURE__ */ jsxs("aside", {
		className: `decision-drawer workbench-panel${dragOffset !== null ? " is-dragging" : ""}`,
		style: { "--panel-drag-offset": `${dragOffset ?? 0}px` },
		"aria-label": "工作台详情面板",
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "drawer-drag-handle",
				"aria-label": "向右滑动关闭详情",
				onPointerDown: startPanelDrag,
				onPointerMove: movePanelDrag,
				onPointerUp: finishPanelDrag,
				onPointerCancel: finishPanelDrag,
				children: /* @__PURE__ */ jsx("i", {})
			}),
			/* @__PURE__ */ jsx("button", {
				className: "drawer-close",
				onClick: onClose,
				"aria-label": "关闭详情",
				children: /* @__PURE__ */ jsx(X, {})
			}),
			panel?.kind === "job" && job ? /* @__PURE__ */ jsx(DecisionDrawer, {
				job,
				tab: panel.tab,
				completed,
				engagement: engagement[job.id] || "NEW",
				events: events[job.id] || [],
				outcomes: outcomes[job.id] || [],
				onTab: (tab) => onOpenJob(job, tab),
				onAction,
				onCommand,
				onOutcome
			}) : panel?.kind === "sync" ? /* @__PURE__ */ jsx(SyncPanel, {
				sync,
				onSync,
				onSetSync,
				notify
			}) : panel?.kind === "identity" ? /* @__PURE__ */ jsx(IdentityPanel, {
				auth,
				onAuth,
				notify
			}) : panel?.kind === "commitments" ? /* @__PURE__ */ jsx(CommitmentsPanel, {
				jobs: commitmentJobs,
				engagement,
				onOpen: (job) => onOpenJob(job, "engagement")
			}) : /* @__PURE__ */ jsx(NotificationPanel, {
				items: notifications,
				onOpen: onNotification,
				notify
			})
		]
	});
}
function CommitmentsPanel({ jobs, engagement, onOpen }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs("div", {
		className: "panel-heading",
		children: [/* @__PURE__ */ jsx(BriefcaseBusiness, {}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("h1", { children: "我的承接" }), /* @__PURE__ */ jsx("p", { children: "关注、接单和需要继续处理的职位" })] })]
	}), /* @__PURE__ */ jsx("div", {
		className: "mobile-commitment-list",
		children: jobs.length ? jobs.map((job) => /* @__PURE__ */ jsxs("button", {
			onClick: () => onOpen(job),
			children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsxs("b", { children: [
				job.company,
				" · ",
				job.role
			] }), /* @__PURE__ */ jsx("small", { children: engagement[job.id] === "ACCEPTED" ? "接单中 · 推进交付或记录结果" : "关注中 · 评估后接单或取消关注" })] }), /* @__PURE__ */ jsx(ChevronRight, {})]
		}, job.id)) : /* @__PURE__ */ jsx("p", { children: "暂无承接职位。" })
	})] });
}
function DecisionDrawer({ job, tab, completed, engagement, events, outcomes, onTab, onAction, onCommand, onOutcome }) {
	const tabOptions = [
		"judgement",
		"engagement",
		"trail",
		"replay"
	];
	const tabLabel = {
		judgement: "判断",
		engagement: "承接与结果",
		trail: "决策轨迹",
		replay: "回放"
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("div", {
			className: "drawer-title",
			children: [/* @__PURE__ */ jsxs("h1", { children: [
				job.company,
				" ",
				/* @__PURE__ */ jsx("span", { children: "·" }),
				" ",
				job.role
			] }), /* @__PURE__ */ jsxs("span", {
				className: `decision-state ${job.eligibility.toLowerCase()}`,
				children: [
					stateLabel[engagement],
					" · ",
					decisionGroupMeta[job.group].title
				]
			})]
		}),
		/* @__PURE__ */ jsx(DirectGlassSegment, {
			value: tab,
			options: tabOptions.map((value) => ({
				value,
				label: tabLabel[value]
			})),
			onChange: onTab,
			className: "drawer-tabs",
			ariaLabel: "职位详情视图"
		}),
		tab === "judgement" ? /* @__PURE__ */ jsxs(Fragment, { children: [
			/* @__PURE__ */ jsxs("div", {
				className: "drawer-metrics",
				children: [
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "项目推进",
						value: job.globalScore
					}),
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "探索机会",
						value: job.explorationScore
					}),
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "个人适配",
						value: job.personalScore
					}),
					/* @__PURE__ */ jsx(DecisionMetric, {
						label: "最终得分",
						value: job.finalScore,
						emphasis: "final"
					})
				]
			}),
			/* @__PURE__ */ jsx(DrawerSection, {
				title: "当前事实",
				children: /* @__PURE__ */ jsx("dl", {
					className: "facts",
					children: Object.entries(job.facts).map(([key, value]) => /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: key }), /* @__PURE__ */ jsx("dd", {
						className: value === "UNKNOWN" ? "unknown" : "",
						children: value
					})] }, key))
				})
			}),
			/* @__PURE__ */ jsx(DrawerSection, {
				title: "为什么现在做",
				children: /* @__PURE__ */ jsx("ul", {
					className: "explanations",
					children: job.scoreNotes.map((note) => /* @__PURE__ */ jsx("li", { children: note }, note))
				})
			}),
			job.risks.length > 0 && /* @__PURE__ */ jsx(DrawerSection, {
				title: "风险与缺失",
				children: /* @__PURE__ */ jsx("ul", {
					className: "explanations risks",
					children: job.risks.map((note) => /* @__PURE__ */ jsx("li", { children: note }, note))
				})
			}),
			/* @__PURE__ */ jsxs(DrawerSection, {
				title: "证据来源",
				children: [/* @__PURE__ */ jsx("div", {
					className: "evidence-list",
					children: job.evidence.map((item) => /* @__PURE__ */ jsx("span", { children: item }, item))
				}), /* @__PURE__ */ jsxs("p", {
					className: "snapshot-note",
					children: [
						"冻结快照 · ",
						job.id,
						" · Policy v1.2"
					]
				})]
			}),
			/* @__PURE__ */ jsx(TalentSupplySection, { job }),
			/* @__PURE__ */ jsx(DrawerSection, {
				title: "当前建议",
				children: /* @__PURE__ */ jsx("div", {
					className: "drawer-actions",
					children: job.actions.map((action) => {
						const complete = completed.includes(`${job.id}:${action.id}`);
						return /* @__PURE__ */ jsxs("button", {
							className: complete ? "completed" : "",
							onClick: () => onAction(job, action),
							disabled: complete,
							children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsxs("b", { children: [complete ? "已记录：" : "", action.label] }), /* @__PURE__ */ jsx("small", { children: action.detail })] }), complete ? /* @__PURE__ */ jsx(Check, {}) : /* @__PURE__ */ jsx(ChevronRight, {})]
						}, action.id);
					})
				})
			})
		] }) : tab === "engagement" ? /* @__PURE__ */ jsx(EngagementPanel, {
			job,
			state: engagement,
			outcomes,
			onCommand,
			onOutcome
		}) : tab === "trail" ? /* @__PURE__ */ jsx(DrawerSection, {
			title: "决策轨迹",
			children: /* @__PURE__ */ jsx("div", {
				className: "trail-list",
				children: events.length ? events.map((event) => /* @__PURE__ */ jsxs("div", { children: [
					/* @__PURE__ */ jsx("time", { children: event.at }),
					/* @__PURE__ */ jsx("b", { children: event.type }),
					/* @__PURE__ */ jsx("small", { children: event.reason || "顾问工作台" })
				] }, event.id)) : /* @__PURE__ */ jsx("p", {
					className: "muted",
					children: "尚无操作记录"
				})
			})
		}) : /* @__PURE__ */ jsx(ReplayPanel, {
			job,
			events,
			outcomes
		})
	] });
}
function EngagementPanel({ job, state, outcomes, onCommand, onOutcome }) {
	const [stage, setStage] = useState("推荐采纳");
	const [rating, setRating] = useState("4");
	const [note, setNote] = useState("");
	const actions = legalActions(job, state);
	const stageOptions = [
		"推荐采纳",
		"面试",
		"Offer",
		"入职",
		"关闭",
		"反馈"
	].map((value) => ({
		value,
		label: value
	}));
	const ratingOptions = [{
		value: "",
		label: "不打分"
	}, ...[
		1,
		2,
		3,
		4,
		5
	].map((value) => ({
		value: String(value),
		label: `${value} 分`
	}))];
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs(DrawerSection, {
		title: "承接状态",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "engagement-state",
			children: [/* @__PURE__ */ jsx("span", { children: stateLabel[state] }), /* @__PURE__ */ jsx("p", { children: state === "ACCEPTED" ? "已进入你的交付列表。请推进或补充结果。" : state === "WATCHED" ? "已保留关注位；评估完成后可接单。" : state === "DISMISSED" ? "该职位处于暂不考虑状态。" : "该职位尚未进入承接工作流。" })]
		}), /* @__PURE__ */ jsx("div", {
			className: "command-grid",
			children: actions.length ? actions.map((command) => /* @__PURE__ */ jsxs("button", {
				className: command === "ACCEPT" ? "primary" : "",
				onClick: () => onCommand(job, command),
				children: [actionLabel[command], /* @__PURE__ */ jsx(ChevronRight, {})]
			}, command)) : /* @__PURE__ */ jsx("p", {
				className: "muted",
				children: "当前没有允许的承接操作"
			})
		})]
	}), state === "ACCEPTED" && /* @__PURE__ */ jsxs(DrawerSection, {
		title: "记录结果",
		children: [/* @__PURE__ */ jsxs("form", {
			className: "outcome-form",
			onSubmit: (event) => {
				event.preventDefault();
				onOutcome(job, stage, rating ? Number(rating) : void 0, note || void 0);
				setNote("");
			},
			children: [
				/* @__PURE__ */ jsx(FilterSelect, {
					value: stage,
					onChange: (value) => setStage(value),
					ariaLabel: "结果阶段",
					options: stageOptions
				}),
				/* @__PURE__ */ jsx(FilterSelect, {
					value: rating,
					onChange: setRating,
					ariaLabel: "结果评分",
					options: ratingOptions
				}),
				/* @__PURE__ */ jsx("input", {
					value: note,
					onChange: (event) => setNote(event.target.value),
					placeholder: "备注（可选）"
				}),
				/* @__PURE__ */ jsxs("button", {
					className: "btn primary",
					type: "submit",
					children: [/* @__PURE__ */ jsx(ClipboardCheck, {}), "记录"]
				})
			]
		}), /* @__PURE__ */ jsx("div", {
			className: "outcome-list",
			children: outcomes.map((item) => /* @__PURE__ */ jsxs("div", { children: [
				/* @__PURE__ */ jsx("b", { children: item.stage }),
				/* @__PURE__ */ jsxs("span", { children: [item.rating ? `${item.rating} 分 · ` : "", item.note || "已记录"] }),
				/* @__PURE__ */ jsx("time", { children: item.at })
			] }, item.id))
		})]
	})] });
}
function ReplayPanel({ job, events, outcomes }) {
	const replay = {
		decisionId: `D-${job.id.slice(4)}`,
		runId: "RUN-1842",
		snapshotAt: "2026-08-10 11:28",
		policyVersion: "Policy v1.2",
		rank: job.rank,
		reasons: job.scoreNotes,
		risks: job.scoreNotes.slice(0, 1),
		evidence: job.evidence
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsx(DrawerSection, {
			title: "冻结决策快照",
			children: /* @__PURE__ */ jsxs("dl", {
				className: "facts",
				children: [
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "快照时间" }), /* @__PURE__ */ jsx("dd", { children: replay.snapshotAt })] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "策略版本" }), /* @__PURE__ */ jsx("dd", { children: replay.policyVersion })] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "当时排名" }), /* @__PURE__ */ jsxs("dd", { children: [
						"第 ",
						replay.rank,
						" 位"
					] })] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "决策编号" }), /* @__PURE__ */ jsx("dd", { children: replay.decisionId })] })
				]
			})
		}),
		/* @__PURE__ */ jsxs(DrawerSection, {
			title: "当时理由与风险",
			children: [/* @__PURE__ */ jsx("ul", {
				className: "explanations",
				children: replay.reasons.map((item) => /* @__PURE__ */ jsx("li", { children: item }, item))
			}), /* @__PURE__ */ jsx("div", {
				className: "evidence-list",
				children: replay.evidence.map((item) => /* @__PURE__ */ jsx("span", { children: item }, item))
			})]
		}),
		/* @__PURE__ */ jsx(DrawerSection, {
			title: "后续操作",
			children: /* @__PURE__ */ jsx("div", {
				className: "trail-list",
				children: events.map((item) => /* @__PURE__ */ jsxs("div", { children: [
					/* @__PURE__ */ jsx("time", { children: item.at }),
					/* @__PURE__ */ jsx("b", { children: item.type }),
					/* @__PURE__ */ jsx("small", { children: item.reason || "顾问工作台" })
				] }, item.id))
			})
		}),
		/* @__PURE__ */ jsx(DrawerSection, {
			title: "后续结果",
			children: outcomes.length ? /* @__PURE__ */ jsx("div", {
				className: "outcome-list",
				children: outcomes.map((item) => /* @__PURE__ */ jsxs("div", { children: [
					/* @__PURE__ */ jsx("b", { children: item.stage }),
					/* @__PURE__ */ jsx("span", { children: item.note || "已记录" }),
					/* @__PURE__ */ jsx("time", { children: item.at })
				] }, item.id))
			}) : /* @__PURE__ */ jsx("p", {
				className: "muted",
				children: "暂无结果记录；回放以上方冻结数据为准。"
			})
		})
	] });
}
function SyncPanel({ sync, onSync, onSetSync, notify }) {
	const setDemo = (state) => {
		onSetSync({
			...sync,
			state,
			errors: state === "ERROR" ? ["飞书消息源超时"] : state === "INCOMPLETE" ? ["职位事实未完整返回"] : []
		});
		notify(state === "INCOMPLETE" ? "已切换为同步不完整演示状态" : "已切换为同步失败演示状态");
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("div", {
			className: "panel-heading",
			children: [/* @__PURE__ */ jsx(ShieldCheck, {}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("h1", { children: "同步状态" }), /* @__PURE__ */ jsx("p", { children: "当前推荐只使用完整快照" })] })]
		}),
		/* @__PURE__ */ jsx(DrawerSection, {
			title: "当前快照",
			children: /* @__PURE__ */ jsxs("dl", {
				className: "facts",
				children: [
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "状态" }), /* @__PURE__ */ jsx("dd", { children: sync.state === "READY" ? "已同步" : sync.state === "RUNNING" ? "同步中" : sync.state === "INCOMPLETE" ? "本次同步不完整" : sync.state === "AUTH_EXPIRED" ? "飞书授权已过期" : sync.state === "ERROR" ? "同步失败" : "尚未同步" })] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "读取进度" }), /* @__PURE__ */ jsxs("dd", { children: [
						sync.rowsRead ?? 0,
						" / ",
						sync.rowsExpected ?? "—"
					] })] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "更新时间" }), /* @__PURE__ */ jsx("dd", { children: sync.updatedAt || "—" })] })
				]
			})
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "drawer-actions",
			children: [
				/* @__PURE__ */ jsxs("button", {
					onClick: onSync,
					children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: "重新同步" }), /* @__PURE__ */ jsx("small", { children: "生成新的完整推荐快照" })] }), /* @__PURE__ */ jsx(ChevronRight, {})]
				}),
				/* @__PURE__ */ jsxs("button", {
					onClick: () => setDemo("INCOMPLETE"),
					children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: "模拟同步不完整" }), /* @__PURE__ */ jsx("small", { children: "验证推荐阻断界面" })] }), /* @__PURE__ */ jsx(TriangleAlert, {})]
				}),
				/* @__PURE__ */ jsxs("button", {
					onClick: () => setDemo("ERROR"),
					children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: "模拟同步失败" }), /* @__PURE__ */ jsx("small", { children: "验证异常与恢复提示" })] }), /* @__PURE__ */ jsx(X, {})]
				})
			]
		}),
		/* @__PURE__ */ jsx("p", {
			className: "panel-caption",
			children: "当前为前端演示。后端接入后，这里映射 sync_runs 与推荐生成状态。"
		})
	] });
}
function IdentityPanel({ auth, onAuth, notify }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("div", {
			className: "panel-heading",
			children: [/* @__PURE__ */ jsx(CircleUserRound, {}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("h1", { children: auth.consultant }), /* @__PURE__ */ jsx("p", { children: "顾问会话与数据授权" })] })]
		}),
		/* @__PURE__ */ jsx(DrawerSection, {
			title: "账户状态",
			children: /* @__PURE__ */ jsxs("dl", {
				className: "facts",
				children: [/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "登录状态" }), /* @__PURE__ */ jsx("dd", { children: "已登录" })] }), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "飞书授权" }), /* @__PURE__ */ jsx("dd", {
					className: auth.needsReauth ? "unknown" : "",
					children: auth.needsReauth ? "已过期" : "正常"
				})] })]
			})
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "drawer-actions",
			children: [/* @__PURE__ */ jsxs("button", {
				onClick: () => {
					onAuth({
						...auth,
						needsReauth: !auth.needsReauth,
						authorized: auth.needsReauth
					});
					notify(auth.needsReauth ? "已恢复授权演示状态" : "已切换为授权过期演示状态");
				},
				children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: auth.needsReauth ? "恢复授权状态" : "模拟授权过期" }), /* @__PURE__ */ jsx("small", { children: "用于验证后端授权恢复入口" })] }), /* @__PURE__ */ jsx(ShieldCheck, {})]
			}), /* @__PURE__ */ jsxs("button", {
				onClick: () => notify("已退出演示会话；刷新页面将恢复本地演示身份"),
				children: [/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: "退出" }), /* @__PURE__ */ jsx("small", { children: "不影响任何外部账号" })] }), /* @__PURE__ */ jsx(ChevronRight, {})]
			})]
		})
	] });
}
function NotificationPanel({ items, onOpen, notify }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("div", {
			className: "panel-heading",
			children: [/* @__PURE__ */ jsx(BellRing, {}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("h1", { children: "今日提醒" }), /* @__PURE__ */ jsx("p", { children: "同步、承接与每日推荐摘要" })] })]
		}),
		/* @__PURE__ */ jsx("div", {
			className: "notification-list",
			children: items.map((item) => /* @__PURE__ */ jsxs("button", {
				className: item.read ? "read" : "",
				onClick: () => onOpen(item),
				children: [
					/* @__PURE__ */ jsx("i", {}),
					/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: item.title }), /* @__PURE__ */ jsx("small", { children: item.detail })] }),
					/* @__PURE__ */ jsx(ChevronRight, {})
				]
			}, item.id))
		}),
		/* @__PURE__ */ jsxs(DrawerSection, {
			title: "推送预览",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "push-preview",
					children: [/* @__PURE__ */ jsx("b", { children: "今日职位判断" }), /* @__PURE__ */ jsx("span", { children: "Top 3 已生成 · 1 个承接待处理" })]
				}),
				/* @__PURE__ */ jsxs("button", {
					className: "btn",
					onClick: () => notify("已模拟发送到 Felix 的飞书提醒"),
					children: [/* @__PURE__ */ jsx(Send, {}), "模拟发送"]
				}),
				/* @__PURE__ */ jsx("p", {
					className: "panel-caption",
					children: "仅展示推送内容，不会发送到外部系统。"
				})
			]
		})
	] });
}
function CommandConfirm({ pending, onClose, onConfirm }) {
	const [reason, setReason] = useState("当前没精力");
	const dismiss = pending.command === "DISMISS";
	const reasonOptions = [
		"无资源",
		"不符合方向",
		"客户/职位质量不足",
		"当前没精力",
		"已有其他顾问推进",
		"信息不完整",
		"其他"
	].map((value) => ({
		value,
		label: value
	}));
	return /* @__PURE__ */ jsx("div", {
		className: "command-mask",
		role: "presentation",
		children: /* @__PURE__ */ jsxs("section", {
			className: "command-modal",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": "确认承接操作",
			children: [
				/* @__PURE__ */ jsx("h2", { children: dismiss ? "暂不考虑这个职位？" : "确认接单？" }),
				/* @__PURE__ */ jsx("p", { children: dismiss ? "选择原因后会记录到决策轨迹。" : "接单后该职位将进入你的交付列表。" }),
				dismiss && /* @__PURE__ */ jsx(FilterSelect, {
					value: reason,
					onChange: setReason,
					ariaLabel: "暂不考虑原因",
					options: reasonOptions
				}),
				/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("button", {
					className: "btn",
					onClick: onClose,
					children: "取消"
				}), /* @__PURE__ */ jsx("button", {
					className: "btn primary",
					onClick: () => onConfirm(dismiss ? reason : void 0),
					children: dismiss ? "记录原因" : "确认接单"
				})] })
			]
		})
	});
}
function DrawerSection({ title, children }) {
	return /* @__PURE__ */ jsxs("section", {
		className: "drawer-section",
		children: [/* @__PURE__ */ jsx("h2", { children: title }), children]
	});
}
var supplyDifficultyMeta = {
	low: {
		label: "供给充足",
		tone: "ok"
	},
	medium: {
		label: "供给适中",
		tone: "warn"
	},
	high: {
		label: "供给偏紧",
		tone: "risk"
	}
};
var talentPoolSeed = [
	"王航·海外投放",
	"陈мор·增长运营",
	"李默·GTM 负责人",
	"周屿·达人营销",
	"苏黎·效果广告",
	"林越·品牌市场",
	"何洲·用户增长",
	"顾原·渠道拓展"
];
/** 从 job 确定性推导供给快照：稳定、可复现、与后端弱匹配语义同构（此处为前端演示数据）。 */
function deriveSupply(job) {
	let h = 0;
	for (const ch of job.id) h = h * 31 + ch.charCodeAt(0) >>> 0;
	const count = h % 9;
	const difficulty = count >= 6 ? "low" : count >= 3 ? "medium" : "high";
	const suggestion = count === 0 ? "暂无可匹配候选，建议先扩搜或激活沉睡人才" : difficulty === "high" ? `仅 ${count} 名可匹配候选，供给偏紧，优先精准触达` : difficulty === "medium" ? `${count} 名候选可推进，建议按匹配分分层触达` : `${count} 名候选可选，供给充足，可快速起量`;
	const topMatches = Array.from({ length: Math.min(count, 3) }, (_, i) => ({
		name: talentPoolSeed[(h + i) % talentPoolSeed.length],
		score: Number((.9 - (h >> i + 1) % 30 / 100).toFixed(2))
	})).sort((a, b) => b.score - a.score);
	return {
		matchableTalentCount: count,
		supplyDifficulty: difficulty,
		matchingSuggestion: suggestion,
		reactivatableTalentCount: h % 3,
		topMatches
	};
}
function TalentSupplySection({ job }) {
	const s = deriveSupply(job);
	const meta = supplyDifficultyMeta[s.supplyDifficulty];
	return /* @__PURE__ */ jsxs(DrawerSection, {
		title: "候选供给（人才侧参考）",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "supply-head",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "supply-count",
						children: [/* @__PURE__ */ jsx("strong", { children: s.matchableTalentCount }), /* @__PURE__ */ jsx("span", { children: "可匹配候选" })]
					}),
					/* @__PURE__ */ jsx("span", {
						className: `supply-badge ${meta.tone}`,
						children: meta.label
					}),
					s.reactivatableTalentCount > 0 && /* @__PURE__ */ jsxs("span", {
						className: "supply-reactivate",
						children: [
							"可激活沉睡 ",
							s.reactivatableTalentCount,
							" 人"
						]
					})
				]
			}),
			/* @__PURE__ */ jsx("p", {
				className: "supply-suggestion",
				children: s.matchingSuggestion
			}),
			s.topMatches.length > 0 && /* @__PURE__ */ jsx("div", {
				className: "supply-matches",
				children: s.topMatches.map((m) => /* @__PURE__ */ jsxs("div", {
					className: "supply-match",
					children: [/* @__PURE__ */ jsx("b", { children: m.name }), /* @__PURE__ */ jsxs("span", { children: [
						"匹配 ",
						Math.round(m.score * 100),
						"%"
					] })]
				}, m.name))
			}),
			/* @__PURE__ */ jsx("p", {
				className: "snapshot-note",
				children: "仅供参考 · 不计入最终得分 · 来源 talent-supply 适配层"
			})
		]
	});
}
function JobsView({ jobs, status, setStatus, sort, setSort, view, setView, selected, setSelected, openJob, notify }) {
	const [clientFilter, setClientFilter] = useState("全部客户");
	const [cityFilter, setCityFilter] = useState("全部城市");
	const [compareOpen, setCompareOpen] = useState(false);
	const statusOptions = [{
		value: "全部状态",
		label: "全部状态"
	}, ...statusOrder.map((value) => ({
		value,
		label: value
	}))];
	const sortOptions = [{
		value: "score",
		label: "综合分数 ↓"
	}, {
		value: "hc",
		label: "HC ↓"
	}];
	const clientOptions = [{
		value: "全部客户",
		label: "全部客户"
	}, ...clients.map((client) => ({
		value: client.name,
		label: client.name
	}))];
	const cityOptions = [{
		value: "全部城市",
		label: "全部城市"
	}, ...[
		"上海",
		"北京",
		"深圳",
		"杭州"
	].map((value) => ({
		value,
		label: value
	}))];
	const visibleJobs = jobs.filter((job) => (clientFilter === "全部客户" || job.client === clientFilter) && (cityFilter === "全部城市" || job.city === cityFilter));
	const comparedJobs = visibleJobs.filter((job) => selected.includes(job.id));
	const toggle = (id) => {
		setCompareOpen(false);
		if (selected.includes(id)) setSelected(selected.filter((x) => x !== id));
		else if (selected.length < 3) setSelected([...selected, id]);
		else notify("最多对比 3 个职位");
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsx(Heading, {
			code: "JOB SIGNAL RADAR",
			title: "职位雷达",
			desc: "把新鲜度、招聘意愿、反馈、转化与竞争信号放在同一决策面上。",
			action: /* @__PURE__ */ jsxs("button", {
				className: "btn primary",
				onClick: () => notify("新建职位表单已准备（演示数据不写入真实系统）"),
				children: [/* @__PURE__ */ jsx(Plus, {}), "新增职位"]
			})
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "toolbar",
			children: [
				/* @__PURE__ */ jsx(FilterSelect, {
					value: status,
					onChange: setStatus,
					ariaLabel: "职位状态",
					options: statusOptions
				}),
				/* @__PURE__ */ jsx(FilterSelect, {
					value: sort,
					onChange: setSort,
					ariaLabel: "排序方式",
					options: sortOptions
				}),
				/* @__PURE__ */ jsx(FilterSelect, {
					value: clientFilter,
					onChange: setClientFilter,
					ariaLabel: "客户筛选",
					options: clientOptions
				}),
				/* @__PURE__ */ jsx(FilterSelect, {
					value: cityFilter,
					onChange: setCityFilter,
					ariaLabel: "城市筛选",
					options: cityOptions
				}),
				/* @__PURE__ */ jsx(DirectGlassSegment, {
					value: view,
					options: [{
						value: "list",
						label: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(ListFilter, {}), "决策列表"] })
					}, {
						value: "rail",
						label: /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Activity, {}), "信号轨道"] })
					}],
					onChange: setView,
					className: "glass-seg",
					ariaLabel: "职位视图"
				}),
				comparedJobs.length > 1 && /* @__PURE__ */ jsxs("button", {
					className: "btn primary",
					onClick: () => setCompareOpen(true),
					children: [
						/* @__PURE__ */ jsx(GitCompareArrows, {}),
						"对比 ",
						comparedJobs.length
					]
				})
			]
		}),
		/* @__PURE__ */ jsx("section", {
			className: "card",
			children: view === "list" ? /* @__PURE__ */ jsxs("div", {
				className: "table-wrap",
				children: [/* @__PURE__ */ jsxs("table", {
					className: "data-table",
					children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
						/* @__PURE__ */ jsx("th", { children: "对比" }),
						/* @__PURE__ */ jsx("th", { children: "职位 / 客户" }),
						/* @__PURE__ */ jsx("th", { children: "分数" }),
						/* @__PURE__ */ jsx("th", { children: "状态与判断" }),
						/* @__PURE__ */ jsx("th", { children: "HC" }),
						/* @__PURE__ */ jsx("th", { children: "最近反馈" }),
						/* @__PURE__ */ jsx("th", { children: "推荐" }),
						/* @__PURE__ */ jsx("th", { children: "面试" }),
						/* @__PURE__ */ jsx("th", { children: "Offer" }),
						/* @__PURE__ */ jsx("th", { children: "操作" })
					] }) }), /* @__PURE__ */ jsx("tbody", { children: visibleJobs.map((j) => /* @__PURE__ */ jsxs("tr", { children: [
						/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("input", {
							type: "checkbox",
							checked: selected.includes(j.id),
							onChange: () => toggle(j.id)
						}) }),
						/* @__PURE__ */ jsxs("td", {
							className: "name-cell",
							children: [/* @__PURE__ */ jsx("b", { children: j.name }), /* @__PURE__ */ jsxs("small", { children: [
								j.client,
								" · ",
								j.city
							] })]
						}),
						/* @__PURE__ */ jsx("td", {
							className: "score",
							children: j.score
						}),
						/* @__PURE__ */ jsxs("td", { children: [/* @__PURE__ */ jsx(StatusTag, { s: j.status }), /* @__PURE__ */ jsx("div", {
							className: "reason",
							children: j.reason
						})] }),
						/* @__PURE__ */ jsx("td", {
							className: "mono",
							children: j.hc
						}),
						/* @__PURE__ */ jsx("td", { children: j.feedback }),
						/* @__PURE__ */ jsx("td", { children: j.recommended }),
						/* @__PURE__ */ jsx("td", { children: j.interview }),
						/* @__PURE__ */ jsx("td", { children: j.offer }),
						/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("button", {
							className: "link",
							onClick: () => openJob(j),
							children: "详情 →"
						}) })
					] }, j.id)) })]
				}), visibleJobs.length === 0 && /* @__PURE__ */ jsxs("div", {
					className: "empty",
					children: [/* @__PURE__ */ jsx(Search, {}), "没有符合当前筛选的职位"]
				})]
			}) : /* @__PURE__ */ jsx(SignalRail, {
				jobs: visibleJobs,
				open: openJob
			})
		}),
		compareOpen && /* @__PURE__ */ jsx(Compare, {
			jobs: comparedJobs,
			close: () => setCompareOpen(false)
		})
	] });
}
function SignalRail({ jobs, open }) {
	return /* @__PURE__ */ jsx("div", {
		className: "rail",
		children: jobs.map((j) => {
			const ix = statusOrder.indexOf(j.status);
			const color = j.status === "已关闭" ? "#b32636" : j.status === "拥挤" || j.status === "降温" ? "#7d8795" : "#0071e3";
			return /* @__PURE__ */ jsxs("div", {
				className: "rail-row",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "rail-name",
						children: [/* @__PURE__ */ jsx("button", {
							className: "link",
							onClick: () => open(j),
							children: /* @__PURE__ */ jsx("b", { children: j.name })
						}), /* @__PURE__ */ jsxs("small", { children: [
							j.client,
							" · 评分 ",
							j.score
						] })]
					}),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("div", {
						className: "track",
						style: {
							"--progress": `${ix / 6 * 100}%`,
							"--track-color": color
						},
						children: statusOrder.map((s, i) => /* @__PURE__ */ jsx("i", {
							className: `node ${i <= ix ? "done" : ""} ${i === ix ? "current" : ""}`,
							style: { left: `${i / 6 * 100}%` },
							title: s
						}, s))
					}), /* @__PURE__ */ jsx("div", {
						className: "track-labels",
						children: statusOrder.map((s) => /* @__PURE__ */ jsx("span", { children: s }, s))
					})] }),
					/* @__PURE__ */ jsx("div", {
						className: "reason",
						children: j.reason
					})
				]
			}, j.id);
		})
	});
}
function Compare({ jobs, close }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
		className: "drawer-backdrop",
		onClick: close
	}), /* @__PURE__ */ jsxs("div", {
		className: "modal",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "modal-head",
			children: [/* @__PURE__ */ jsx("b", { children: "职位横向对比" }), /* @__PURE__ */ jsx("button", {
				className: "icon-btn",
				onClick: close,
				children: /* @__PURE__ */ jsx(X, {})
			})]
		}), /* @__PURE__ */ jsxs("div", {
			className: "modal-body compare-grid",
			children: [
				/* @__PURE__ */ jsx("div", {}),
				jobs.map((j) => /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx("b", { children: j.name }) }, j.id)),
				[
					"综合评分",
					"职位新鲜度",
					"招聘意愿",
					"HC / 紧急程度",
					"反馈速度",
					"推荐→面试",
					"面试→Offer",
					"竞争程度",
					"主要风险",
					"建议动作"
				].flatMap((d, i) => /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", { children: d }, d), jobs.map((j) => /* @__PURE__ */ jsx("div", { children: i === 0 ? /* @__PURE__ */ jsx("span", {
					className: "score",
					children: j.score
				}) : i === 1 ? `${Math.max(7, j.score - 72)}/15` : i === 2 ? `${Math.max(8, j.score - 72)}/20` : i === 3 ? `${j.hc} HC · ${j.hc > 2 ? "紧急" : "正常"}` : i === 4 ? j.feedback : i === 5 ? `${Math.round(j.interview / j.recommended * 100)}%` : i === 6 ? `${j.interview ? Math.round(j.offer / j.interview * 100) : 0}%` : i === 7 ? j.status === "拥挤" ? "高" : "中" : i === 8 ? j.reason : j.status === "拥挤" ? "提高推荐门槛" : "优先推进" }, `${d}${j.id}`))] }))
			]
		})]
	})] });
}
function JobTable({ rows, open }) {
	return /* @__PURE__ */ jsx("div", {
		className: "table-wrap",
		children: /* @__PURE__ */ jsxs("table", {
			className: "data-table",
			children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
				/* @__PURE__ */ jsx("th", { children: "职位 / 客户" }),
				/* @__PURE__ */ jsx("th", { children: "综合分" }),
				/* @__PURE__ */ jsx("th", { children: "状态与原因" }),
				/* @__PURE__ */ jsx("th", { children: "HC" }),
				/* @__PURE__ */ jsx("th", { children: "最近反馈" }),
				/* @__PURE__ */ jsx("th", { children: "推荐" }),
				/* @__PURE__ */ jsx("th", { children: "面试" }),
				/* @__PURE__ */ jsx("th", { children: "Offer" }),
				/* @__PURE__ */ jsx("th", { children: "今日建议" })
			] }) }), /* @__PURE__ */ jsx("tbody", { children: rows.map((j) => /* @__PURE__ */ jsxs("tr", { children: [
				/* @__PURE__ */ jsxs("td", {
					className: "name-cell",
					children: [/* @__PURE__ */ jsx("button", {
						className: "link",
						onClick: () => open(j),
						children: /* @__PURE__ */ jsx("b", { children: j.name })
					}), /* @__PURE__ */ jsx("small", { children: j.client })]
				}),
				/* @__PURE__ */ jsx("td", {
					className: "score",
					children: j.score
				}),
				/* @__PURE__ */ jsxs("td", { children: [/* @__PURE__ */ jsx(StatusTag, { s: j.status }), /* @__PURE__ */ jsx("div", {
					className: "reason",
					children: j.reason
				})] }),
				/* @__PURE__ */ jsx("td", {
					className: "mono",
					children: j.hc
				}),
				/* @__PURE__ */ jsx("td", { children: j.feedback }),
				/* @__PURE__ */ jsx("td", { children: j.recommended }),
				/* @__PURE__ */ jsx("td", { children: j.interview }),
				/* @__PURE__ */ jsx("td", { children: j.offer }),
				/* @__PURE__ */ jsx("td", { children: j.status === "拥挤" ? "提高标准" : j.status === "降温" ? "确认预算" : "优先推进" })
			] }, j.id)) })]
		})
	});
}
function JobDetail({ job, onBack, weights, eventType, setEventType, hc, setHc, notify }) {
	const [events2, setEvents2] = useState(events.slice(0, 3));
	const detailWeights = [
		20,
		15,
		15,
		15,
		10,
		10,
		10,
		5
	];
	const add = () => {
		setEvents2([[
			(/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", {
				hour: "2-digit",
				minute: "2-digit"
			}),
			eventType,
			eventType === "HC变化" ? `HC更新为 ${hc}` : "用户新增项目事件"
		], ...events2]);
		notify("事件已记录，状态与评分已重新计算");
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("button", {
			className: "back",
			onClick: onBack,
			children: [/* @__PURE__ */ jsx(ArrowLeft, {}), "返回职位雷达"]
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "detail-top",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "detail-title",
				children: [
					/* @__PURE__ */ jsxs("span", {
						className: "eyebrow",
						children: ["JOB / ", String(job.id).padStart(4, "0")]
					}),
					/* @__PURE__ */ jsx("h1", { children: job.name }),
					/* @__PURE__ */ jsxs("div", {
						className: "meta",
						children: [
							/* @__PURE__ */ jsx("span", { children: job.client }),
							/* @__PURE__ */ jsxs("span", { children: ["PM · ", job.pm] }),
							/* @__PURE__ */ jsx("span", { children: job.city }),
							/* @__PURE__ */ jsx("span", { children: job.salary }),
							/* @__PURE__ */ jsxs("span", { children: ["HC ", job.hc] }),
							/* @__PURE__ */ jsxs("span", { children: ["更新 ", job.feedback] })
						]
					})
				]
			}), /* @__PURE__ */ jsx("div", {
				className: "big-score",
				style: { "--score": job.score },
				children: /* @__PURE__ */ jsx("span", { children: job.score })
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "conclusion",
			children: [
				/* @__PURE__ */ jsx("div", {
					className: "spark",
					children: /* @__PURE__ */ jsx(Sparkles, {})
				}),
				/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: "建议优先投入" }), /* @__PURE__ */ jsxs("p", { children: [job.reason, "。当前推荐到面试转化较高，主要风险是面试池逐渐拥挤，建议提高推荐标准。"] })] }),
				/* @__PURE__ */ jsx(StatusTag, { s: job.status })
			]
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "grid g2",
			children: [/* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "评分依据" }), /* @__PURE__ */ jsx("span", { children: "规则计算 + AI推断" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "card-body score-bars",
					children: [
						"客户真实招聘意愿",
						"职位新鲜度",
						"HC 和紧急程度",
						"客户反馈速度",
						"推荐到面试转化",
						"面试到 Offer 转化",
						"当前竞争程度",
						"历史交付风险"
					].map((n, i) => /* @__PURE__ */ jsxs("div", {
						className: "score-line",
						children: [
							/* @__PURE__ */ jsx("span", { children: n }),
							/* @__PURE__ */ jsx("div", {
								className: "bar",
								children: /* @__PURE__ */ jsx("i", { style: { width: `${Math.min(100, (detailWeights[i] - i % 3) * 100 / detailWeights[i])}%` } })
							}),
							/* @__PURE__ */ jsxs("strong", { children: [
								detailWeights[i] - i % 3,
								" / ",
								detailWeights[i]
							] })
						]
					}, n))
				})]
			}), /* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "建议动作" }), /* @__PURE__ */ jsx("span", { children: "按影响排序" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "card-body side-list",
					children: [
						"向PM确认剩余HC",
						"确认当前面试进度",
						"提高推荐标准",
						"48小时无反馈则降低优先级"
					].map((x, i) => /* @__PURE__ */ jsxs("div", {
						className: "mini-item",
						children: [
							/* @__PURE__ */ jsxs("span", {
								className: "num",
								children: ["0", i + 1]
							}),
							/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: x }), /* @__PURE__ */ jsx("p", { children: i < 2 ? "今天完成 · 高影响" : "本周完成 · 中影响" })] }),
							/* @__PURE__ */ jsx("button", {
								className: "icon-btn",
								onClick: () => notify(`已完成：${x}`),
								children: /* @__PURE__ */ jsx(Check, {})
							})
						]
					}, x))
				})]
			})]
		}),
		/* @__PURE__ */ jsxs("section", {
			className: "card section",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "card-head",
				children: [/* @__PURE__ */ jsx("h2", { children: "职位信号轨道" }), /* @__PURE__ */ jsx("span", { children: "每次判断均可追溯" })]
			}), /* @__PURE__ */ jsx(SignalRail, {
				jobs: [job],
				open: () => {}
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "grid g2 section",
			children: [/* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "招聘漏斗" }), /* @__PURE__ */ jsx("span", { children: "近 90 天" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "card-body funnel",
					children: [
						["推荐", job.recommended],
						["客户查看", Math.max(1, job.recommended - 2)],
						["初面", job.interview],
						["复试", Math.max(1, job.interview - 1)],
						["终面", job.offer + 1],
						["Offer", job.offer],
						["入职", 0]
					].map((x) => /* @__PURE__ */ jsxs("div", {
						className: "funnel-step",
						children: [/* @__PURE__ */ jsx("b", { children: x[1] }), /* @__PURE__ */ jsx("small", { children: x[0] })]
					}, x[0]))
				})]
			}), /* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "当前竞争" }), /* @__PURE__ */ jsx("span", { children: "趋势上升" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "card-body g3 grid",
					children: [
						["参与顾问", "4"],
						["已推荐", job.recommended],
						["面试 / Offer", `${job.interview} / ${job.offer}`]
					].map((x) => /* @__PURE__ */ jsx("div", {
						className: "mini-item",
						children: /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("p", { children: x[0] }), /* @__PURE__ */ jsx("b", {
							className: "score",
							children: x[1]
						})] })
					}, x[0]))
				})]
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "grid g2 section",
			children: [/* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "客户反馈摘要" }), /* @__PURE__ */ jsx("span", { children: "AI结构化提取" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "card-body side-list",
					children: [
						"最近反馈：商业化经验通过，需验证团队管理跨度",
						"高频淘汰：行业深度不足、英文沟通欠缺",
						"重点关注：AI广告客户资源、0→1团队经验",
						"待确认：剩余HC与下一轮面试排期"
					].map((x) => /* @__PURE__ */ jsxs("div", {
						className: "mini-item",
						children: [/* @__PURE__ */ jsx(Sparkles, {}), /* @__PURE__ */ jsx("b", { children: x })]
					}, x))
				})]
			}), /* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "新增项目事件" }), /* @__PURE__ */ jsx("span", { children: "将触发重新计算" })]
				}), /* @__PURE__ */ jsxs("div", {
					className: "card-body",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "toolbar",
						children: [
							/* @__PURE__ */ jsx(FilterSelect, {
								value: eventType,
								onChange: setEventType,
								ariaLabel: "项目事件类型",
								options: [
									"客户反馈",
									"HC变化",
									"面试变化",
									"Offer变化",
									"职位暂停",
									"职位恢复",
									"职位关闭"
								].map((value) => ({
									value,
									label: value
								}))
							}),
							eventType === "HC变化" && /* @__PURE__ */ jsx("input", {
								className: "field",
								type: "number",
								min: 0,
								value: hc,
								onChange: (e) => setHc(+e.target.value)
							}),
							/* @__PURE__ */ jsxs("button", {
								className: "btn primary",
								onClick: add,
								children: [/* @__PURE__ */ jsx(Plus, {}), "记录并重算"]
							})
						]
					}), /* @__PURE__ */ jsx("div", {
						className: "timeline",
						children: events2.map((e, i) => /* @__PURE__ */ jsxs("div", {
							className: "event",
							children: [
								/* @__PURE__ */ jsx("time", { children: e[0] }),
								/* @__PURE__ */ jsx("i", { className: "event-dot" }),
								/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: e[1] }), /* @__PURE__ */ jsx("p", { children: e[2] })] })
							]
						}, `${e[0]}${i}`))
					})]
				})]
			})]
		})
	] });
}
function ClientsView({ clients, open, notify }) {
	const [compare, setCompare] = useState([]);
	const [stateFilter, setStateFilter] = useState("全部合作状态");
	const [sortBy, setSortBy] = useState("score");
	const [compareOpen, setCompareOpen] = useState(false);
	const visibleClients = [...clients].filter((client) => stateFilter === "全部合作状态" || client.state === stateFilter).sort((a, b) => sortBy === "feedback" ? parseInt(a.feedback) - parseInt(b.feedback) : sortBy === "hc" ? b.hc - a.hc : b.score - a.score);
	const comparedClients = visibleClients.filter((client) => compare.includes(client.name));
	const toggle = (name) => {
		setCompareOpen(false);
		if (compare.includes(name)) setCompare(compare.filter((x) => x !== name));
		else if (compare.length < 3) setCompare([...compare, name]);
		else notify("最多对比 3 个客户");
	};
	const reset = () => {
		setStateFilter("全部合作状态");
		setSortBy("score");
		setCompare([]);
		setCompareOpen(false);
		notify("客户筛选已重置");
	};
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsx(Heading, {
			code: "CLIENT INTELLIGENCE",
			title: "客户洞察",
			desc: "识别真实招聘窗口、合作温度与交付风险。",
			action: /* @__PURE__ */ jsxs("button", {
				className: "btn",
				onClick: reset,
				children: [/* @__PURE__ */ jsx(RotateCcw, {}), "重置筛选"]
			})
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "toolbar",
			children: [
				/* @__PURE__ */ jsx(FilterSelect, {
					value: stateFilter,
					onChange: setStateFilter,
					ariaLabel: "合作状态筛选",
					options: [
						"全部合作状态",
						"招聘窗口期",
						"稳定合作",
						"反馈降温"
					].map((value) => ({
						value,
						label: value
					}))
				}),
				/* @__PURE__ */ jsx(FilterSelect, {
					value: sortBy,
					onChange: setSortBy,
					ariaLabel: "客户排序方式",
					options: [
						{
							value: "score",
							label: "优先级 ↓"
						},
						{
							value: "feedback",
							label: "反馈速度 ↑"
						},
						{
							value: "hc",
							label: "总 HC ↓"
						}
					]
				}),
				comparedClients.length > 1 && /* @__PURE__ */ jsxs("button", {
					className: "btn primary",
					onClick: () => setCompareOpen(true),
					children: [
						/* @__PURE__ */ jsx(GitCompareArrows, {}),
						"对比 ",
						comparedClients.length
					]
				})
			]
		}),
		/* @__PURE__ */ jsx("section", {
			className: "card",
			children: /* @__PURE__ */ jsxs("div", {
				className: "table-wrap",
				children: [/* @__PURE__ */ jsxs("table", {
					className: "data-table",
					children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
						/* @__PURE__ */ jsx("th", { children: "对比" }),
						/* @__PURE__ */ jsx("th", { children: "客户 / 行业" }),
						/* @__PURE__ */ jsx("th", { children: "合作状态" }),
						/* @__PURE__ */ jsx("th", { children: "活跃职位" }),
						/* @__PURE__ */ jsx("th", { children: "总HC" }),
						/* @__PURE__ */ jsx("th", { children: "平均反馈" }),
						/* @__PURE__ */ jsx("th", { children: "推荐→面试" }),
						/* @__PURE__ */ jsx("th", { children: "面试→Offer" }),
						/* @__PURE__ */ jsx("th", { children: "历史入职" }),
						/* @__PURE__ */ jsx("th", { children: "意愿" }),
						/* @__PURE__ */ jsx("th", { children: "优先级" }),
						/* @__PURE__ */ jsx("th", { children: "主要风险" })
					] }) }), /* @__PURE__ */ jsx("tbody", { children: visibleClients.map((c) => /* @__PURE__ */ jsxs("tr", { children: [
						/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("input", {
							type: "checkbox",
							checked: compare.includes(c.name),
							onChange: () => toggle(c.name)
						}) }),
						/* @__PURE__ */ jsxs("td", {
							className: "name-cell",
							children: [/* @__PURE__ */ jsx("button", {
								className: "link",
								onClick: () => open(c),
								children: /* @__PURE__ */ jsx("b", { children: c.name })
							}), /* @__PURE__ */ jsx("small", { children: c.industry })]
						}),
						/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx(StatusTag, { s: c.state }) }),
						/* @__PURE__ */ jsx("td", { children: c.active }),
						/* @__PURE__ */ jsx("td", { children: c.hc }),
						/* @__PURE__ */ jsx("td", { children: c.feedback }),
						/* @__PURE__ */ jsx("td", { children: c.r2i }),
						/* @__PURE__ */ jsx("td", { children: c.i2o }),
						/* @__PURE__ */ jsx("td", { children: c.hires }),
						/* @__PURE__ */ jsx("td", { children: c.intent }),
						/* @__PURE__ */ jsx("td", {
							className: "score",
							children: c.score
						}),
						/* @__PURE__ */ jsx("td", { children: c.risk })
					] }, c.name)) })]
				}), visibleClients.length === 0 && /* @__PURE__ */ jsxs("div", {
					className: "empty",
					children: [/* @__PURE__ */ jsx(Search, {}), "没有符合当前筛选的客户"]
				})]
			})
		}),
		compareOpen && /* @__PURE__ */ jsx(ClientCompare, {
			clients: comparedClients,
			close: () => setCompareOpen(false)
		})
	] });
}
function ClientCompare({ clients, close }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
		className: "drawer-backdrop",
		onClick: close
	}), /* @__PURE__ */ jsxs("div", {
		className: "modal",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "modal-head",
			children: [/* @__PURE__ */ jsx("b", { children: "客户横向对比" }), /* @__PURE__ */ jsx("button", {
				className: "icon-btn",
				onClick: close,
				"aria-label": "关闭对比",
				children: /* @__PURE__ */ jsx(X, {})
			})]
		}), /* @__PURE__ */ jsxs("div", {
			className: "modal-body compare-grid",
			children: [
				/* @__PURE__ */ jsx("div", {}),
				clients.map((client) => /* @__PURE__ */ jsx("div", { children: /* @__PURE__ */ jsx("b", { children: client.name }) }, client.name)),
				[
					["合作状态", (client) => client.state],
					["活跃职位", (client) => client.active],
					["总 HC", (client) => client.hc],
					["平均反馈", (client) => client.feedback],
					["推荐→面试", (client) => client.r2i],
					["面试→Offer", (client) => client.i2o],
					["历史入职", (client) => client.hires],
					["招聘意愿", (client) => client.intent],
					["优先级", (client) => /* @__PURE__ */ jsx("span", {
						className: "score",
						children: client.score
					})],
					["主要风险", (client) => client.risk]
				].flatMap(([label, value]) => /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", { children: label }, label), clients.map((client) => /* @__PURE__ */ jsx("div", { children: value(client) }, `${label}${client.name}`))] }))
			]
		})]
	})] });
}
function ClientDetail({ c, onBack, notify }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("button", {
			className: "back",
			onClick: onBack,
			children: [/* @__PURE__ */ jsx(ArrowLeft, {}), "返回客户洞察"]
		}),
		/* @__PURE__ */ jsx(Heading, {
			code: `CLIENT / ${c.industry}`,
			title: c.name,
			desc: `优先级 ${c.score} · ${c.state} · 平均反馈 ${c.feedback}`,
			action: /* @__PURE__ */ jsxs("button", {
				className: "btn primary",
				onClick: () => notify("客户反馈已记录并触发重新判断"),
				children: [/* @__PURE__ */ jsx(Plus, {}), "添加客户反馈"]
			})
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "conclusion",
			children: [/* @__PURE__ */ jsx("div", {
				className: "spark",
				children: /* @__PURE__ */ jsx(Sparkles, {})
			}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsxs("b", { children: [c.name, "当前处于集中招聘窗口期"] }), /* @__PURE__ */ jsxs("p", { children: [
				"近30天新增 ",
				c.active,
				" 个职位，平均反馈时间缩短至 ",
				c.feedback,
				"，建议提高交付优先级。"
			] })] })]
		}),
		/* @__PURE__ */ jsx("div", {
			className: "grid g3",
			children: [
				["活跃职位", c.active],
				["总 HC", c.hc],
				["历史入职", c.hires]
			].map((x) => /* @__PURE__ */ jsxs("div", {
				className: "card card-body",
				children: [/* @__PURE__ */ jsx("span", {
					className: "eyebrow",
					children: x[0]
				}), /* @__PURE__ */ jsx("div", {
					className: "score",
					style: {
						fontSize: 28,
						marginTop: 8
					},
					children: x[1]
				})]
			}, x[0]))
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "grid g2 section",
			children: [/* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "当前活跃职位" }), /* @__PURE__ */ jsxs("span", { children: [c.active, " 个"] })]
				}), /* @__PURE__ */ jsx(JobTable, {
					rows: jobs.filter((j) => j.client === c.name).concat(jobs.slice(0, Math.max(0, 3 - jobs.filter((j) => j.client === c.name).length))),
					open: () => notify("已打开关联职位")
				})]
			}), /* @__PURE__ */ jsxs("section", {
				className: "card",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "card-head",
					children: [/* @__PURE__ */ jsx("h2", { children: "合作判断" }), /* @__PURE__ */ jsx("span", { children: "近6个月" })]
				}), /* @__PURE__ */ jsx("div", {
					className: "card-body side-list",
					children: [
						"人才偏好：头部AI商业化经验、团队从0到1",
						"高频淘汰：缺少复杂销售经验",
						"需求变更：近30天 2 次，处于可控范围",
						"合作风险：面试标准近期小幅抬高",
						"建议动作：锁定本周业务负责人面试档期"
					].map((x, i) => /* @__PURE__ */ jsxs("div", {
						className: "mini-item",
						children: [/* @__PURE__ */ jsxs("span", {
							className: "num",
							children: ["0", i + 1]
						}), /* @__PURE__ */ jsx("b", { children: x })]
					}, x))
				})]
			})]
		}),
		/* @__PURE__ */ jsxs("section", {
			className: "card section",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "card-head",
				children: [/* @__PURE__ */ jsx("h2", { children: "客户事件时间线" }), /* @__PURE__ */ jsx("span", { children: "可追溯" })]
			}), /* @__PURE__ */ jsx("div", {
				className: "card-body timeline",
				children: events.concat([[
					"06-28",
					"新增职位",
					"新增 AI 解决方案销售，HC 3"
				], [
					"06-04",
					"需求变化",
					"薪资上限提高 15%"
				]]).map((e) => /* @__PURE__ */ jsxs("div", {
					className: "event",
					children: [
						/* @__PURE__ */ jsx("time", { children: e[0] }),
						/* @__PURE__ */ jsx("i", { className: "event-dot" }),
						/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: e[1] }), /* @__PURE__ */ jsx("p", { children: e[2] })] })
					]
				}, e[0]))
			})]
		})
	] });
}
function Alerts({ setExtraTasks, notify, setDrawer }) {
	const alerts = [
		"云帆智能连续7天未反馈",
		"商业化增长经理转化率下降12%",
		"海外增长负责人面试池已拥挤",
		"星河科技进入招聘窗口期",
		"Creator Partnership负责人新增2个HC",
		"棱镜互动近14天需求变更3次",
		"AI解决方案销售参与顾问增至6人",
		"用户增长负责人产生Offer"
	];
	const [handled, setHandled] = useState([]);
	const [riskFilter, setRiskFilter] = useState("全部风险等级");
	const [clientFilter, setClientFilter] = useState("全部客户");
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsx(Heading, {
			code: "DYNAMIC ALERTS",
			title: "动态预警",
			desc: "聚合需要人工确认的机会、变化和失活信号。"
		}),
		/* @__PURE__ */ jsxs("div", {
			className: "toolbar",
			children: [/* @__PURE__ */ jsx(FilterSelect, {
				value: riskFilter,
				onChange: setRiskFilter,
				ariaLabel: "预警风险等级",
				options: [
					"全部风险等级",
					"高风险",
					"机会"
				].map((value) => ({
					value,
					label: value
				}))
			}), /* @__PURE__ */ jsx(FilterSelect, {
				value: clientFilter,
				onChange: setClientFilter,
				ariaLabel: "预警客户筛选",
				options: [{
					value: "全部客户",
					label: "全部客户"
				}, ...clients.map((client) => ({
					value: client.name,
					label: client.name
				}))]
			})]
		}),
		/* @__PURE__ */ jsx("section", {
			className: "card",
			children: /* @__PURE__ */ jsx("div", {
				className: "actions",
				children: alerts.map((x, i) => /* @__PURE__ */ jsxs("div", {
					className: "action-row",
					style: { opacity: handled.includes(i) ? .5 : 1 },
					children: [
						/* @__PURE__ */ jsx(StatusTag, { s: i % 3 === 0 ? "高风险" : i % 3 === 1 ? "关注" : "机会" }),
						/* @__PURE__ */ jsxs("div", {
							className: "action-main",
							children: [/* @__PURE__ */ jsx("b", { children: x }), /* @__PURE__ */ jsx("small", { children: i % 2 ? "基于近7天业务事件变化" : "超过预设阈值，建议今天确认" })]
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "impact",
							children: [
								/* @__PURE__ */ jsx("strong", { children: i % 3 === 2 ? "机会升温" : "需人工确认" }),
								"置信度 ",
								88 + i,
								"%"
							]
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "row-actions",
							children: [
								/* @__PURE__ */ jsx("button", {
									className: "btn",
									onClick: () => setDrawer(x),
									children: "依据"
								}),
								/* @__PURE__ */ jsx("button", {
									className: "btn",
									onClick: () => {
										setExtraTasks((v) => v.includes(x) ? v : [...v, x]);
										notify("已转为今日任务");
									},
									children: "转任务"
								}),
								/* @__PURE__ */ jsx("button", {
									className: "icon-btn",
									onClick: () => {
										setHandled([...handled, i]);
										notify("预警已处理");
									},
									children: /* @__PURE__ */ jsx(Check, {})
								})
							]
						})
					]
				}, x))
			})
		})
	] });
}
function Rules({ weights, setWeights, notify }) {
	const names = [
		"项目推进",
		"探索机会",
		"个人适配"
	];
	const notes = [
		"阶段、动量、转化、HC 空间与竞争度",
		"新鲜度、方向匹配、有效 HC 与低竞争",
		"顾问关系、容量、历史交付与战略方向"
	];
	const total = weights.reduce((a, b) => a + b, 0);
	const canApply = total === 100;
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Heading, {
		code: "POLICY / FELIX V1.3",
		title: "判断策略",
		desc: "调整关注侧重点，不等于手工指定职位排名；HC、已入职和关闭状态始终是硬规则。",
		action: /* @__PURE__ */ jsxs("div", {
			className: `tag ${canApply ? "blue" : "orange"}`,
			children: [
				"当前合计 ",
				total,
				"%",
				canApply ? "" : " · 需为 100%"
			]
		})
	}), /* @__PURE__ */ jsxs("div", {
		className: "grid g2",
		children: [/* @__PURE__ */ jsxs("section", {
			className: "card",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "card-head",
				children: [/* @__PURE__ */ jsx("h2", { children: "三层软权重" }), /* @__PURE__ */ jsx("button", {
					className: "link",
					onClick: () => {
						setWeights([
							60,
							25,
							15
						]);
						notify("已恢复默认策略");
					},
					children: "恢复默认"
				})]
			}), /* @__PURE__ */ jsxs("div", {
				className: "card-body strategy-rules",
				children: [
					names.map((n, i) => /* @__PURE__ */ jsxs("label", {
						className: "rule-row",
						children: [
							/* @__PURE__ */ jsxs("span", { children: [/* @__PURE__ */ jsx("b", { children: n }), /* @__PURE__ */ jsx("small", { children: notes[i] })] }),
							/* @__PURE__ */ jsx("input", {
								type: "range",
								min: "5",
								max: "80",
								value: weights[i],
								onChange: (e) => {
									const w = [...weights];
									w[i] = +e.target.value;
									setWeights(w);
								}
							}),
							/* @__PURE__ */ jsxs("output", { children: [weights[i], "%"] })
						]
					}, n)),
					/* @__PURE__ */ jsxs("button", {
						className: "btn primary",
						style: { marginTop: 16 },
						disabled: !canApply,
						onClick: () => notify("策略已保存；后端将生成新的 policy_version 和推荐快照"),
						children: [/* @__PURE__ */ jsx(Check, {}), "保存并生成新推荐"]
					}),
					!canApply && /* @__PURE__ */ jsx("p", {
						className: "rule-validation",
						children: "三层权重总和需为 100%，才能提交给 Agent 重新计算。"
					}),
					/* @__PURE__ */ jsxs("p", {
						className: "policy-boundary",
						children: [/* @__PURE__ */ jsx(ShieldCheck, {}), "不可调整：HC、已入职、职位关闭、项目归属与数据冲突规则。"]
					})
				]
			})]
		}), /* @__PURE__ */ jsxs("section", {
			className: "card",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "card-head",
				children: [/* @__PURE__ */ jsx("h2", { children: "影响预览" }), /* @__PURE__ */ jsx("span", { children: "由 Agent 返回" })]
			}), /* @__PURE__ */ jsxs("div", {
				className: "card-body",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "conclusion",
					children: [/* @__PURE__ */ jsx("div", {
						className: "spark",
						children: /* @__PURE__ */ jsx(Activity, {})
					}), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: "只预览软排序变化" }), /* @__PURE__ */ jsx("p", { children: "正式保存前展示哪些职位上升、下降，以及仍被硬规则拦截的职位。" })] })]
				}), [
					[
						"项目推进",
						"当前 60%",
						"强化在途项目与真实反馈"
					],
					[
						"探索机会",
						"当前 25%",
						"保留新项目验证空间"
					],
					[
						"个人适配",
						"当前 15%",
						"只做个人修正，不覆盖项目事实"
					]
				].map((x) => /* @__PURE__ */ jsxs("div", {
					className: "mini-item",
					children: [/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("b", { children: x[0] }), /* @__PURE__ */ jsx("p", { children: x[2] })] }), /* @__PURE__ */ jsx("strong", {
						style: {
							marginLeft: "auto",
							color: "var(--blue)"
						},
						children: x[1]
					})]
				}, x[0]))]
			})]
		})]
	})] });
}
function TalentBackendCard() {
	const [health, setHealth] = useState(null);
	const [state, setState] = useState("loading");
	useEffect(() => {
		let alive = true;
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 2500);
		fetch("/api/v1/talent/health", {
			signal: ctrl.signal,
			credentials: "include"
		}).then((r) => r.ok ? r.json() : Promise.reject()).then((h) => {
			if (alive) {
				setHealth(h);
				setState("live");
			}
		}).catch(() => {
			if (alive) setState("offline");
		}).finally(() => clearTimeout(t));
		return () => {
			alive = false;
			ctrl.abort();
		};
	}, []);
	const isMysql = health?.backend === "mysql" && health.connected;
	const badge = state === "offline" ? {
		s: "已就绪",
		cls: ""
	} : isMysql ? {
		s: "已连接",
		cls: ""
	} : {
		s: "内存回退",
		cls: "warn"
	};
	return /* @__PURE__ */ jsxs("section", {
		className: "card talent-backend",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "source-head",
				children: [/* @__PURE__ */ jsx("div", {
					className: "source-icon",
					children: /* @__PURE__ */ jsx(Database, {})
				}), /* @__PURE__ */ jsx("span", {
					className: `supply-badge ${isMysql ? "ok" : badge.cls === "warn" ? "warn" : "risk"}`,
					children: badge.s
				})]
			}),
			/* @__PURE__ */ jsx("h3", { children: "人才库（阿里云 RDS）" }),
			state === "loading" && /* @__PURE__ */ jsx("p", { children: "正在检测人才库连接…" }),
			state === "offline" && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs("p", { children: [
				"人才库读写与供给匹配【代码已就绪】。此预览未连后端 API，填写 ",
				/* @__PURE__ */ jsx("code", { children: ".env" }),
				" 的 ",
				/* @__PURE__ */ jsx("code", { children: "BRAINX_MYSQL_*" }),
				" 凭据并启动服务后，此处会实时显示真库连接状态。"
			] }), /* @__PURE__ */ jsxs("div", {
				className: "backend-facts",
				children: [/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "切库方式" }), /* @__PURE__ */ jsxs("dd", { children: [
					"填凭据 → ",
					/* @__PURE__ */ jsx("code", { children: "npm run talent:health" }),
					" 自检"
				] })] }), /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "连不通" }), /* @__PURE__ */ jsx("dd", { children: "自动降级内存库（功能不中断）" })] })]
			})] }),
			state === "live" && health && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("p", { children: health.hint }), /* @__PURE__ */ jsxs("div", {
				className: "backend-facts",
				children: [
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "当前后端" }), /* @__PURE__ */ jsx("dd", {
						className: isMysql ? "" : "unknown",
						children: isMysql ? "MySQL 真库" : "内存回退"
					})] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "连通性" }), /* @__PURE__ */ jsx("dd", {
						className: health.connected ? "" : "unknown",
						children: health.connected ? "已连通" : "未连通"
					})] }),
					/* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "建表状态" }), /* @__PURE__ */ jsx("dd", { children: health.schema })] }),
					health.config && /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "目标库" }), /* @__PURE__ */ jsxs("dd", { children: [
						health.config.database || "—",
						" @ ",
						health.config.host
					] })] }),
					health.degraded && /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("dt", { children: "诊断" }), /* @__PURE__ */ jsx("dd", {
						className: "unknown",
						children: health.degraded
					})] })
				]
			})] })
		]
	});
}
function Sources({ notify }) {
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Heading, {
		code: "DATA SOURCES",
		title: "数据源",
		desc: "MVP 演示连接状态；不连接真实账号，不写入外部系统。"
	}), /* @__PURE__ */ jsxs("div", {
		className: "source-grid",
		children: [/* @__PURE__ */ jsx(TalentBackendCard, {}), sourceNames.map((n, i) => /* @__PURE__ */ jsxs("section", {
			className: "card source",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "source-head",
					children: [/* @__PURE__ */ jsx("div", {
						className: "source-icon",
						children: /* @__PURE__ */ jsx(Database, {})
					}), /* @__PURE__ */ jsx(StatusTag, { s: i === 5 ? "同步异常" : i === 4 ? "权限受限" : "已连接" })]
				}),
				/* @__PURE__ */ jsx("h3", { children: n }),
				/* @__PURE__ */ jsxs("p", { children: [
					"最后同步：",
					i < 3 ? "14:28" : "昨天 22:10",
					" · ",
					i === 5 ? "缺少邮件正文权限" : "读取权限正常"
				] }),
				/* @__PURE__ */ jsxs("div", {
					className: "completeness",
					children: [/* @__PURE__ */ jsx("span", { children: "数据完整度" }), /* @__PURE__ */ jsxs("b", { children: [92 - i * 4, "%"] })]
				}),
				/* @__PURE__ */ jsx("div", {
					className: "bar",
					children: /* @__PURE__ */ jsx("i", { style: {
						width: `${92 - i * 4}%`,
						background: i === 5 ? "var(--orange)" : "var(--blue)"
					} })
				}),
				/* @__PURE__ */ jsxs("button", {
					className: "btn",
					style: { marginTop: 14 },
					onClick: () => notify(i === 5 ? "已生成权限修复指引" : "字段清单已展开"),
					children: [/* @__PURE__ */ jsx(Settings2, {}), "查看字段"]
				})
			]
		}, n))]
	})] });
}
//#endregion
//#region pages/main.tsx
var main_exports = /* @__PURE__ */ __exportAll({});
if (typeof document !== "undefined") {
	const root = document.getElementById("root");
	if (!root) throw new Error("Missing #root element");
	createRoot(root).render(/* @__PURE__ */ jsx(StrictMode, { children: /* @__PURE__ */ jsx(DecisionWorkbench, {}) }));
}
//#endregion
//#region \0virtual:vinext-server-entry
var buildId = "79010560-c80d-43fd-9870-eaf0f2e415f5";
var vinextConfig = {
	"basePath": "",
	"trailingSlash": false,
	"redirects": [],
	"rewrites": {
		"beforeFiles": [],
		"afterFiles": [],
		"fallback": []
	},
	"headers": [],
	"expireTime": 31536e3,
	"i18n": null,
	"images": {}
};
function isrGet(key) {
	return isrGet$1(key);
}
function isrSet(key, data, revalidateSeconds, tags, expireSeconds) {
	return isrSet$1(key, data, revalidateSeconds, tags, expireSeconds);
}
function triggerBackgroundRegeneration(key, renderFn, errorContext) {
	return triggerBackgroundRegeneration$1(key, renderFn, errorContext);
}
function isrCacheKey(router, pathname) {
	return isrCacheKey$1(router, pathname, buildId);
}
async function renderToStringAsync(element) {
	const stream = await renderToReadableStream(element);
	await stream.allReady;
	return new Response(stream).text();
}
async function renderIsrPassToStringAsync(element) {
	return await runWithServerInsertedHTMLState(() => runWithHeadState(() => _runWithCacheState(() => runWithPrivateCache(() => runWithFetchCache(async () => renderToStringAsync(element))))));
}
var DocumentComponent = null;
var pageRoutes = [{
	pattern: "/main",
	patternParts: ["main"],
	isDynamic: false,
	params: [],
	module: main_exports,
	filePath: "/home/user/brainx/frontend/decision-workbench/pages/main.tsx"
}];
var _pageRouteTrie = buildRouteTrie(pageRoutes);
var apiRoutes = [];
var _apiRouteTrie = buildRouteTrie(apiRoutes);
function matchRoute(url, routes) {
	const pathname = url.split("?")[0];
	const urlParts = (pathname === "/" ? "/" : pathname.replace(/\/$/, "")).split("/").filter(Boolean);
	return trieMatch(routes === pageRoutes ? _pageRouteTrie : _apiRouteTrie, urlParts);
}
function matchPageRoute(url, request) {
	return matchRoute(url, pageRoutes);
}
function parseQuery(url) {
	const qs = url.split("?")[1];
	if (!qs) return {};
	const p = new URLSearchParams(qs);
	const q = {};
	for (const [k, v] of p) if (k in q) q[k] = Array.isArray(q[k]) ? q[k].concat(v) : [q[k], v];
	else q[k] = v;
	return q;
}
function mergeRouteParamsIntoQuery(query, params) {
	return Object.assign(query, params);
}
function patternToNextFormat(pattern) {
	return pattern.replace(/:([^\/]+?)\+(?=\/|$)/g, "[...$1]").replace(/:([^\/]+?)\*(?=\/|$)/g, "[[...$1]]").replace(/:([^\/]+?)(?=\/|$)/g, "[$1]");
}
function collectAssetTags(manifest, moduleIds, scriptNonce) {
	const m = manifest && Object.keys(manifest).length > 0 ? manifest : typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__ || null;
	const tags = [];
	const seen = /* @__PURE__ */ new Set();
	const nonceAttr = createNonceAttribute(scriptNonce);
	var lazyChunks = typeof globalThis !== "undefined" && globalThis.__VINEXT_LAZY_CHUNKS__ || null;
	var lazySet = lazyChunks && lazyChunks.length > 0 ? new Set(lazyChunks) : null;
	if (typeof globalThis !== "undefined" && globalThis.__VINEXT_CLIENT_ENTRY__) {
		const entry = globalThis.__VINEXT_CLIENT_ENTRY__;
		seen.add(entry);
		tags.push("<link rel=\"modulepreload\"" + nonceAttr + " href=\"/" + entry + "\" />");
		tags.push("<script type=\"module\"" + nonceAttr + " src=\"/" + entry + "\" crossorigin><\/script>");
	}
	if (m) {
		var allFiles = [];
		if (moduleIds && moduleIds.length > 0) {
			for (var mi = 0; mi < moduleIds.length; mi++) {
				var id = moduleIds[mi];
				var files = m[id];
				if (!files) {
					for (var mk in m) if (id.endsWith("/" + mk) || id === mk) {
						files = m[mk];
						break;
					}
				}
				if (files) for (var fi = 0; fi < files.length; fi++) allFiles.push(files[fi]);
			}
			for (var key in m) {
				var vals = m[key];
				if (!vals) continue;
				for (var vi = 0; vi < vals.length; vi++) {
					var file = vals[vi];
					var basename = file.split("/").pop() || "";
					if (basename.startsWith("framework-") || basename.startsWith("vinext-") || basename.includes("vinext-client-entry") || basename.includes("vinext-app-browser-entry")) allFiles.push(file);
				}
			}
		} else for (var akey in m) {
			var avals = m[akey];
			if (avals) for (var ai = 0; ai < avals.length; ai++) allFiles.push(avals[ai]);
		}
		for (var ti = 0; ti < allFiles.length; ti++) {
			var tf = allFiles[ti];
			if (tf.charAt(0) === "/") tf = tf.slice(1);
			if (seen.has(tf)) continue;
			seen.add(tf);
			if (tf.endsWith(".css")) tags.push("<link rel=\"stylesheet\"" + nonceAttr + " href=\"/" + tf + "\" />");
			else if (tf.endsWith(".js")) {
				if (lazySet && lazySet.has(tf)) continue;
				tags.push("<link rel=\"modulepreload\"" + nonceAttr + " href=\"/" + tf + "\" />");
				tags.push("<script type=\"module\"" + nonceAttr + " src=\"/" + tf + "\" crossorigin><\/script>");
			}
		}
	}
	return tags.join("\n  ");
}
async function renderPage(request, url, manifest, ctx, middlewareHeaders) {
	if (ctx) return runWithExecutionContext(ctx, () => _renderPage(request, url, manifest, middlewareHeaders));
	return _renderPage(request, url, manifest, middlewareHeaders);
}
async function _renderPage(request, url, manifest, middlewareHeaders) {
	const localeInfo = {
		locale: void 0,
		url,
		hadPrefix: false,
		domainLocale: void 0,
		redirectUrl: void 0
	};
	const locale = localeInfo.locale;
	const routeUrl = localeInfo.url;
	const currentDefaultLocale = void 0;
	const domainLocales = void 0;
	if (localeInfo.redirectUrl) return new Response(null, {
		status: 307,
		headers: { Location: localeInfo.redirectUrl }
	});
	const match = matchRoute(routeUrl, pageRoutes);
	if (!match) return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>", {
		status: 404,
		headers: { "Content-Type": "text/html" }
	});
	const { route, params } = match;
	return runWithRequestContext(createRequestContext({ executionContext: getRequestExecutionContext() }), async () => {
		ensureFetchPatch();
		try {
			const routePattern = patternToNextFormat(route.pattern);
			const query = mergeRouteParamsIntoQuery(parseQuery(routeUrl), params);
			if (typeof setSSRContext === "function") setSSRContext({
				pathname: routePattern,
				query,
				asPath: routeUrl,
				locale,
				locales: void 0,
				defaultLocale: currentDefaultLocale,
				domainLocales
			});
			const pageModule = route.module;
			const PageComponent = pageModule.default;
			if (!PageComponent) return new Response("Page has no default export", { status: 500 });
			const scriptNonce = getScriptNonceFromHeaderSources(request.headers, middlewareHeaders);
			var _fontLinkHeader = "";
			var _allFp = [];
			try {
				var _fpGoogle = typeof getSSRFontPreloads$1 === "function" ? getSSRFontPreloads$1() : [];
				var _fpLocal = typeof getSSRFontPreloads === "function" ? getSSRFontPreloads() : [];
				_allFp = _fpGoogle.concat(_fpLocal);
				if (_allFp.length > 0) _fontLinkHeader = _allFp.map(function(p) {
					return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin";
				}).join(", ");
			} catch (e) {}
			const pageDataResult = await resolvePagesPageData({
				applyRequestContexts() {
					if (typeof setSSRContext === "function") setSSRContext({
						pathname: routePattern,
						query,
						asPath: routeUrl,
						locale,
						locales: void 0,
						defaultLocale: currentDefaultLocale,
						domainLocales
					});
				},
				buildId,
				createGsspReqRes() {
					return createPagesReqRes({
						body: void 0,
						query,
						request,
						url: routeUrl
					});
				},
				createPageElement(currentPageProps) {
					return wrapWithRouterContext(React.createElement(PageComponent, currentPageProps));
				},
				fontLinkHeader: _fontLinkHeader,
				i18n: {
					locale,
					locales: void 0,
					defaultLocale: currentDefaultLocale,
					domainLocales
				},
				isrCacheKey,
				isrGet,
				isrSet,
				expireSeconds: vinextConfig.expireTime,
				pageModule,
				params,
				query,
				renderIsrPassToStringAsync,
				route: { isDynamic: route.isDynamic },
				routePattern,
				routeUrl,
				runInFreshUnifiedContext(callback) {
					return runWithRequestContext(createRequestContext({ executionContext: getRequestExecutionContext() }), async () => {
						ensureFetchPatch();
						return callback();
					});
				},
				safeJsonStringify,
				sanitizeDestination,
				scriptNonce,
				triggerBackgroundRegeneration
			});
			if (pageDataResult.kind === "response") return pageDataResult.response;
			let pageProps = pageDataResult.pageProps;
			var gsspRes = pageDataResult.gsspRes;
			let isrRevalidateSeconds = pageDataResult.isrRevalidateSeconds;
			return renderPagesPageResponse({
				assetTags: collectAssetTags(manifest, route.filePath ? [route.filePath] : [], scriptNonce),
				buildId,
				clearSsrContext() {
					if (typeof setSSRContext === "function") setSSRContext(null);
				},
				createPageElement(currentPageProps) {
					return wrapWithRouterContext(React.createElement(PageComponent, currentPageProps));
				},
				DocumentComponent,
				flushPreloads: typeof flushPreloads === "function" ? flushPreloads : void 0,
				fontLinkHeader: _fontLinkHeader,
				fontPreloads: _allFp,
				getFontLinks() {
					try {
						return typeof getSSRFontLinks === "function" ? getSSRFontLinks() : [];
					} catch (e) {
						return [];
					}
				},
				getFontStyles() {
					try {
						var allFontStyles = [];
						if (typeof getSSRFontStyles$1 === "function") allFontStyles.push(...getSSRFontStyles$1());
						if (typeof getSSRFontStyles === "function") allFontStyles.push(...getSSRFontStyles());
						return allFontStyles;
					} catch (e) {
						return [];
					}
				},
				getSSRHeadHTML: typeof getSSRHeadHTML === "function" ? getSSRHeadHTML : void 0,
				gsspRes,
				isrCacheKey,
				expireSeconds: vinextConfig.expireTime,
				isrRevalidateSeconds,
				isrSet,
				i18n: {
					locale,
					locales: void 0,
					defaultLocale: currentDefaultLocale,
					domainLocales
				},
				pageProps,
				params,
				renderDocumentToString(element) {
					return renderToStringAsync(element);
				},
				renderToReadableStream(element) {
					return renderToReadableStream(element);
				},
				resetSSRHead: typeof resetSSRHead === "function" ? resetSSRHead : void 0,
				routePattern,
				routeUrl,
				safeJsonStringify,
				scriptNonce
			});
		} catch (e) {
			console.error("[vinext] SSR error:", e);
			reportRequestError(e instanceof Error ? e : new Error(String(e)), {
				path: url,
				method: request.method,
				headers: Object.fromEntries(request.headers.entries())
			}, {
				routerKind: "Pages Router",
				routePath: route.pattern,
				routeType: "render"
			}).catch(() => {});
			return new Response("Internal Server Error", { status: 500 });
		}
	});
}
async function handleApiRoute(request, url) {
	return handlePagesApiRoute({
		match: matchRoute(url, apiRoutes),
		request,
		url,
		reportRequestError(error, routePattern) {
			console.error("[vinext] API error:", error);
			reportRequestError(error, {
				path: url,
				method: request.method,
				headers: Object.fromEntries(request.headers.entries())
			}, {
				routerKind: "Pages Router",
				routePath: routePattern,
				routeType: "route"
			});
		}
	});
}
async function runMiddleware() {
	return { continue: true };
}
//#endregion
export { handleApiRoute, matchPageRoute, pageRoutes, renderPage, runMiddleware, vinextConfig };
