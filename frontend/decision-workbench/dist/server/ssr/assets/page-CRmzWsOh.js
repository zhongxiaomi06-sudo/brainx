import { a as Check, c as require_jsx_runtime, i as ChevronRight, m as __toESM, o as createLucideIcon, p as require_react, t as X } from "../index.js";
import { t as Menu } from "./menu-BupA4KLO.js";
//#region node_modules/lucide-react/dist/esm/icons/arrow-up-right.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ArrowUpRight = createLucideIcon("ArrowUpRight", [["path", {
	d: "M7 7h10v10",
	key: "1tivn9"
}], ["path", {
	d: "M7 17 17 7",
	key: "1vkiza"
}]]);
//#endregion
//#region app/showcase/editorial/page.tsx
var import_jsx_runtime = require_jsx_runtime();
var focusCopy = {
	today: {
		index: "01 / TODAY",
		title: "先做最值得推进的三个职位",
		text: "推荐、核验与承接被放在同一张判断面上。",
		tasks: [
			[
				"01",
				"39‑AI · 资深海外投放经理",
				"高动能推进"
			],
			[
				"02",
				"上海蝴蝶梦境 · 资深广告优化师",
				"需要核验"
			],
			[
				"03",
				"Aha.AI · B2B 投放专员",
				"已查看"
			]
		]
	},
	signal: {
		index: "02 / SIGNAL",
		title: "不只看分数，也看正在发生什么",
		text: "HC、反馈、阶段和竞争信号共同决定这一步是否值得投入。",
		tasks: [
			[
				"HC",
				"剩余职位与项目状态",
				"已确认"
			],
			[
				"→",
				"客户反馈与推进节奏",
				"24h 内"
			],
			[
				"!",
				"待验证的关键事实",
				"不占 Top 3"
			]
		]
	},
	rules: {
		index: "03 / RULES",
		title: "规则可见，判断才可解释",
		text: "每个推荐都有快照、依据和允许执行的下一步。",
		tasks: [
			[
				"01",
				"硬条件先行",
				"关闭 / 入职 / HC"
			],
			[
				"02",
				"个人适配只做修正",
				"不覆盖事实"
			],
			[
				"03",
				"未知就是未知",
				"先核验"
			]
		]
	}
};
var tiles = [
	{
		focus: "today",
		label: "today / focus",
		className: "tile-a"
	},
	{
		focus: "signal",
		label: "signal / evidence",
		className: "tile-b"
	},
	{
		focus: "rules",
		label: "next",
		className: "tile-c",
		glyph: "→"
	},
	{
		focus: "today",
		label: "one page",
		className: "tile-d"
	},
	{
		focus: "rules",
		label: "policy / trace",
		className: "tile-e"
	},
	{
		focus: "signal",
		label: "rank / now",
		className: "tile-f"
	},
	{
		focus: "today",
		label: "decide",
		className: "tile-g",
		glyph: "+"
	}
];
function BtexEditorialShowcase() {
	const [menuOpen, setMenuOpen] = (0, import_react.useState)(false);
	const [focus, setFocus] = (0, import_react.useState)(null);
	const trigger = (0, import_react.useRef)(null);
	const current = focus ? focusCopy[focus] : null;
	(0, import_react.useEffect)(() => {
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			setMenuOpen(false);
			setFocus(null);
			trigger.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const closeMenu = () => setMenuOpen(false);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "editorial-showcase",
		id: "top",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "editorial-topbar",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						href: "#top",
						className: "editorial-brand",
						"aria-label": "B-tex 叙事展示首页",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "∞" }), "B‑tex"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "editorial-center",
						children: "职位决策台 / 叙事版"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						className: "editorial-menu",
						type: "button",
						onClick: () => setMenuOpen(true),
						"aria-expanded": menuOpen,
						"aria-controls": "editorial-menu",
						children: ["菜单 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Menu, {})]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "editorial-hero",
				"aria-labelledby": "editorial-title",
				children: [
					tiles.map((tile, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						ref: index === 0 ? trigger : void 0,
						className: `hero-tile ${tile.className}`,
						type: "button",
						onClick: () => setFocus(tile.focus),
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: String(index + 1).padStart(2, "0") }),
							tile.glyph && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: tile.glyph }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: tile.label })
						]
					}, tile.className)),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "editorial-wordmark",
						"aria-hidden": "true",
						children: "B‑tex"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "editorial-claim",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "editorial-kicker",
								children: "JOB DECISION WORKBENCH"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h1", {
								id: "editorial-title",
								children: [
									"让每一次职位判断，",
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
									"都落到清晰的下一步。"
								]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "把职位、客户、项目事实与个人工作节奏放在同一张判断面上。" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
								className: "editorial-link",
								href: "/",
								children: ["进入职位决策台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronRight, {})]
							})
						]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "editorial-section editorial-about",
				id: "about",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "section-index",
					children: "01 / WHAT IT DOES"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "about-layout",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
							"先判断事实，",
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: "再安排注意力。" })
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "about-copy",
							children: "B‑tex 不把所有职位塞进一个排行榜。它先收口关闭、入职、HC 与归属事实，再把真正值得推进、需要核验和暂不推荐的机会放进不同工作区。"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "事实优先" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "UNKNOWN 不会被写成 0；没有加入项目，就不会伪装成可直接承接。" })] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "行动优先" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "分数只作为判断线索，职位行首先告诉你：现在具体该做什么。" })] })
					]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "editorial-section editorial-principle",
				id: "logic",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "section-index",
						children: "02 / THE LOGIC"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
						"从一条信号，",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
						"到一次",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "可解释的行动。" })
					] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "不用在表格、项目和历史记录间来回寻找。每个职位都有一张当下判断，也保留那一刻的快照。" })] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "logic-steps",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "01" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "↙" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "先排除硬条件" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "关闭、已入职、HC 为 0 与重复项目不进入正式推荐。" })
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "02" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "↗" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "再组织可信机会" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "推进、探索、个人适配和判断可靠度都能回到事实与证据。" })
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "03" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "→" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "只给允许的下一步" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "验证、关注、接单或完成，由服务端规则决定，不由前端猜测。" })
							] })
						]
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "editorial-section editorial-demo",
				id: "demo",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "demo-heading",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "section-index",
						children: "03 / IN ONE PLACE"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
						"不必先记住。",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: "先看下一步。" })
					] })]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "demo-surface",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "∞" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "active",
								children: "今天"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "职位" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "客户" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "预警" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "规则" })
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "demo-center",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "demo-bar",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "今日职位判断" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("small", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}), "快照已同步"] })]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "demo-title",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "今天先做这 3 个职位" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "9 个有效机会 · 3 个待核验" })]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "demo-tasks",
									children: focusCopy.today.tasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: task[0] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: task[1] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: task[2] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronRight, {})
									] }, task[0]))
								})
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
							className: "demo-side",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "和 B‑tex 对话" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "“把今天值得推进的职位，按事实完整度与下一步排出来。”" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "已过滤关闭、入职与重复项目，并保留需要确认的机会。" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: [
									"today",
									"signal",
									"rules"
								].map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setFocus(item),
									children: focusCopy[item].index.split(" / ")[1]
								}, item)) })
							]
						})
					]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "editorial-section editorial-roadmap",
				id: "scope",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "section-index",
						children: "04 / BUILD WITH TRUST"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
						"当前能做什么，",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: "就清楚展示什么。" })
					] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "01" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "今天的判断" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "按方向组织正式 Top 3、需要确认和排除机会。" })
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "02" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "承接与回放" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "演示关注、接单、结果记录与冻结的历史判断。" })
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "03" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "统一前端表面" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "为后端同步、权限、通知与轨迹预留可替换的数据适配层。" })
						] })
					] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "roadmap-note",
						children: "这是前端可演示版本：交互与本地状态可用，真实接口、飞书授权和推送由后端后续接入。"
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "editorial-outro",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "section-index",
						children: "B‑TEX / FACTS BECOME ACTION"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
						"下一次判断，",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: "从这里开始。" })
					] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						href: "/",
						children: ["进入职位决策台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowUpRight, {})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("footer", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "B‑tex" }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "职位决策叙事版" }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "为清晰的下一步而建" })
					] })
				]
			}),
			current && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "editorial-preview",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "preview-title",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					className: "preview-scrim",
					type: "button",
					"aria-label": "关闭预览",
					onClick: () => setFocus(null)
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						className: "preview-close",
						type: "button",
						onClick: () => setFocus(null),
						children: ["返回拼贴 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, {})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: current.index }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
						id: "preview-title",
						children: current.title
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: current.text }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: current.tasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: task[0] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: task[1] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: task[2] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, {})
					] }, task[0])) })
				] })]
			}),
			menuOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
				className: "editorial-menu-overlay",
				id: "editorial-menu",
				"aria-label": "叙事展示页菜单",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: closeMenu,
						children: ["关闭 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, {})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("nav", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							onClick: closeMenu,
							href: "#about",
							children: "介绍"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							onClick: closeMenu,
							href: "#logic",
							children: "判断逻辑"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							onClick: closeMenu,
							href: "#demo",
							children: "工作台"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							onClick: closeMenu,
							href: "#scope",
							children: "范围"
						})
					] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						href: "/",
						children: ["进入 B‑tex 工作台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronRight, {})]
					})
				]
			})
		]
	});
}
//#endregion
export { BtexEditorialShowcase as default };
