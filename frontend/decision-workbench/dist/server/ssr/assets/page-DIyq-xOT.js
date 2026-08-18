import { a as Check, c as require_jsx_runtime, i as ChevronRight, m as __toESM, n as ShieldCheck, o as createLucideIcon, p as require_react, r as CircleHelp, t as X } from "../index.js";
import { t as Menu } from "./menu-BupA4KLO.js";
//#region node_modules/lucide-react/dist/esm/icons/arrow-right.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var ArrowRight = createLucideIcon("ArrowRight", [["path", {
	d: "M5 12h14",
	key: "1ays0h"
}], ["path", {
	d: "m12 5 7 7-7 7",
	key: "xquz4c"
}]]);
//#endregion
//#region node_modules/lucide-react/dist/esm/icons/panel-right.js
/**
* @license lucide-react v0.468.0 - ISC
*
* This source code is licensed under the ISC license.
* See the LICENSE file in the root directory of this source tree.
*/
var PanelRight = createLucideIcon("PanelRight", [["rect", {
	width: "18",
	height: "18",
	x: "3",
	y: "3",
	rx: "2",
	key: "afitv7"
}], ["path", {
	d: "M15 3v18",
	key: "14nvp0"
}]]);
//#endregion
//#region app/showcase/showcase.css
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
//#endregion
//#region app/showcase/page.tsx
var import_jsx_runtime = require_jsx_runtime();
var views = {
	today: {
		label: "今日判断",
		eyebrow: "TODAY / PRIORITY",
		title: "今天先做这 3 个职位",
		summary: "已先处理关闭、入职、HC 与项目重复，再按当前可推进性排序。",
		rows: [
			[
				"01",
				"39‑AI · 资深海外投放经理",
				"高动能推进",
				"推进 82"
			],
			[
				"02",
				"上海蝴蝶梦境 · 资深广告优化师",
				"需要核验",
				"探索 95"
			],
			[
				"03",
				"Aha.AI · B2B 投放专员",
				"已查看",
				"个人 71"
			]
		],
		note: "9 个有效机会 · 3 个待核验 · 2 个承接中"
	},
	signal: {
		label: "关键事实",
		eyebrow: "SIGNAL / EVIDENCE",
		title: "判断先回到事实",
		summary: "未知、缺失与已确认信息分开表达，避免把历史或推测当成现在。",
		rows: [
			[
				"HC",
				"39‑AI · 剩余 HC",
				"已确认",
				"1 个"
			],
			[
				"!",
				"上海蝴蝶梦境 · 项目归属",
				"待核验",
				"不占 Top 3"
			],
			[
				"→",
				"科漫智能 · 客户反馈",
				"24 小时内",
				"可推进"
			]
		],
		note: "每一条推荐都有事实来源与有效时间"
	},
	trace: {
		label: "判断轨迹",
		eyebrow: "TRACE / REPLAY",
		title: "当时为什么这样判断",
		summary: "快照冻结当下的排名、证据与规则；后续动作只作为之后发生的信息。",
		rows: [
			[
				"01",
				"08.11 · 推荐快照",
				"Policy v1.2",
				"Final 80"
			],
			[
				"02",
				"确认 Offer 状态",
				"已记录",
				"08.12"
			],
			[
				"03",
				"接单并推进",
				"承接中",
				"下一步"
			]
		],
		note: "当前事实不会改写历史判断"
	}
};
function BtexShowcase() {
	const [view, setView] = (0, import_react.useState)("today");
	const [menuOpen, setMenuOpen] = (0, import_react.useState)(false);
	const [helpOpen, setHelpOpen] = (0, import_react.useState)(false);
	const active = views[view];
	(0, import_react.useEffect)(() => {
		const onKey = (event) => {
			if (event.key === "Escape") {
				setMenuOpen(false);
				setHelpOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "btex-showcase",
		id: "top",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "btex-showcase-nav",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						className: "btex-showcase-brand",
						href: "#top",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "∞" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "B‑tex" })]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("nav", {
						"aria-label": "展示页导航",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
								href: "#product",
								children: "产品"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
								href: "#principles",
								children: "判断原则"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
								href: "#scope",
								children: "当前范围"
							})
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						className: "nav-cta",
						href: "/",
						children: ["打开工作台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowRight, {})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						className: "mobile-menu",
						type: "button",
						onClick: () => setMenuOpen(true),
						"aria-label": "打开菜单",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Menu, {})
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "launch",
				id: "product",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "launch-copy",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "launch-kicker",
							children: "B‑TEX / JOB DECISION WORKBENCH"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h1", { children: [
							"让职位判断，",
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
							"直接变成下一步。"
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "launch-description",
							children: "B‑tex 把职位、客户与项目事实归在一处。它不要求你记住所有线索，而是在需要决定的时候给出清晰、可解释、可以执行的下一步。"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "launch-actions",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
								className: "primary-launch",
								href: "/",
								children: ["进入职位决策台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowRight, {})]
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								className: "quiet-launch",
								type: "button",
								onClick: () => setHelpOpen(true),
								children: ["它如何判断 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleHelp, {})]
							})]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
							className: "launch-caption",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}), "当前为前端演示版 · 本地状态与交互已可用"]
						})
					]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					className: "workbench-frame",
					"aria-label": "B-tex 工作台预览",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "frame-topbar",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "frame-user",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "∞" }), " Felix"]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "frame-snapshot",
								children: "Snapshot #1842 · 11:28"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
								className: "frame-status",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}), "已同步"]
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "frame-content",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
							className: "frame-rail",
							"aria-hidden": "true",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "⌘" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {
									className: "selected",
									children: "⊞"
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "〽" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "◌" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { children: "⌁" })
							]
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "frame-main",
							children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "frame-heading",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: active.eyebrow }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: active.title }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: active.note })
									] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => setHelpOpen(true),
										"aria-label": "说明",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleHelp, {})
									})]
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "frame-switch",
									role: "tablist",
									"aria-label": "预览内容",
									children: Object.keys(views).map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
										type: "button",
										role: "tab",
										"aria-selected": view === item,
										className: view === item ? "active" : "",
										onClick: () => setView(item),
										children: views[item].label
									}, item))
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "frame-summary",
									children: active.summary
								}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
									className: "frame-list",
									children: active.rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: row[0] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: row[1] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: row[2] })] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: row[3] }),
										/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronRight, {})
									] }, row[0] + row[1]))
								})
							]
						})]
					})]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "principles",
				id: "principles",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "section-intro",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "01 / THE DECISION" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
						"少一点“信息”，",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
						"多一点",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "可以决定的事。" })
					] })]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "principle-list",
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "01" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "先把事实收口" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "关闭、入职、HC、项目归属与当前状态优先处理。UNKNOWN 就是 UNKNOWN，不写成看似确定的数字。" })
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "02" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "再给出可信排序" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "推进、探索、个人适配与判断可靠度并列呈现。分数是线索，而不是替代判断的答案。" })
						] }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "03" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "只展示允许的动作" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "验证、关注、接单、完成，都由当前身份与事实决定。前端不擅自推断权限或补全缺失事实。" })
						] })
					]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "evidence-band",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "02 / EXPLAINABLE BY DEFAULT" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
					"每一次推荐，",
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
					"都能回到它的来处。"
				] })] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "当前事实" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: "职位关系、Offer、HC、最新活动" })] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "判断说明" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: "评分拆解、风险与未知原因" })] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", { children: "冻结回放" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", { children: "当时快照与后续结果并列呈现" })] })
				] })]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "scope",
				id: "scope",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "03 / THE CURRENT SURFACE" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", { children: [
						"为后端留好接口，",
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
						"但不假装它已经接上。"
					] })] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "scope-grid",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, {}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "今日判断" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "按业务阶段组织 Top 3、核验与排除区。" })
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PanelRight, {}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "并排详情" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "判断、承接、轨迹与回放都留在同一工作流。" })
							] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { children: [
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)(ShieldCheck, {}),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "本地可演示" }),
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "同步、身份、通知与承接状态可完整走通。" })
							] })
						]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "scope-note",
						children: "当前是前端原型：真实排序、权限、同步与推送均等待后端适配层接入。"
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "final-cta",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "B‑TEX / FACTS BECOME ACTION" }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: "下一步，不必靠记住。" }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						href: "/",
						children: ["打开职位决策台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowRight, {})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("footer", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "B‑tex" }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "职位决策工作台" }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "2026" })
					] })
				]
			}),
			helpOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "help-dialog",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "help-title",
				onClick: () => setHelpOpen(false),
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					className: "help-scrim",
					type: "button",
					"aria-label": "关闭说明"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
					onClick: (event) => event.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dialog-close",
							onClick: () => setHelpOpen(false),
							"aria-label": "关闭说明",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, {})
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "HOW B‑TEX WORKS" }),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h2", {
							id: "help-title",
							children: [
								"先判断事实，",
								/* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
								"再分配注意力。"
							]
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "1" }), " 排除关闭、入职、HC 为 0 和重复机会。"] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "2" }), " 以当前事实组织推进、核验与观察。"] }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "3" }), " 只展示服务端允许的下一步动作。"] })
						] })
					]
				})]
			}),
			menuOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("aside", {
				className: "showcase-drawer",
				"aria-label": "展示页菜单",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: () => setMenuOpen(false),
						children: ["关闭 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, {})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("nav", { children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							href: "#product",
							onClick: () => setMenuOpen(false),
							children: "产品"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							href: "#principles",
							onClick: () => setMenuOpen(false),
							children: "判断原则"
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", {
							href: "#scope",
							onClick: () => setMenuOpen(false),
							children: "当前范围"
						})
					] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						href: "/",
						children: ["打开工作台 ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArrowRight, {})]
					})
				]
			})
		]
	});
}
//#endregion
export { BtexShowcase as default };
