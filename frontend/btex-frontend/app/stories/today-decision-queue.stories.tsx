import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";
import { seedSync } from "../decision-demo";
import { FilterSelect } from "../workbench-controls";
import { TodayDecisionQueue } from "../workbench-today";

const meta = {
  title: "业务组件/今日决策队列",
  component: TodayDecisionQueue,
  args: {
    activeJobId: null,
    completed: [],
    jobs: [],
    engagement: {},
    sync: seedSync,
    open: fn(),
    onAction: fn(),
    onFeedback: fn(),
    tray: [],
    onToggleTray: fn(),
    onRemoveTray: fn(),
    onConfirmTray: fn(),
    folders: [],
    folderMode: false,
    onFolderMode: fn(),
    onAssignFolder: fn(),
    onCreateFolder: fn(),
    onOpenSources: fn(),
  },
  decorators: [(Story) => <div style={{ padding: 24, background: "#f4f6f7" }}><Story /></div>],
} satisfies Meta<typeof TodayDecisionQueue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyRealSource: Story = { args: { mode: "connected" } };

function FilterToolbarPrototype() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [source, setSource] = useState("TTC 职位系统");
  const [stage, setStage] = useState("面试中");
  const [sort, setSort] = useState("recommended");
  const activeFilters = [source && `来源：${source}`, stage && `状态：${stage}`].filter(Boolean);
  return <section className="filter-prototype-card">
    <header><div><span>DECISION QUEUE</span><h2>待判断职位</h2></div><strong>10 个</strong></header>
    <div className="filter-prototype-toolbar">
      <label><Search/><input aria-label="搜索职位或公司" placeholder="搜索职位、公司或关键词"/></label>
      <div className="filter-prototype-filter-wrap">
        <button className={filtersOpen ? "is-active" : ""} type="button" onClick={() => setFiltersOpen(value => !value)} aria-expanded={filtersOpen}>
          <SlidersHorizontal/>筛选{activeFilters.length > 0 && <i>{activeFilters.length}</i>}
        </button>
        {filtersOpen && <div className="filter-prototype-popover">
          <div><b>筛选职位</b><button type="button" onClick={() => setFiltersOpen(false)} aria-label="关闭筛选"><X/></button></div>
          <fieldset><legend>数据来源</legend>
            {["全部来源", "TTC 职位系统", "驾驶舱"].map(value => <button type="button"
              className={source === value ? "selected" : ""}
              onClick={() => setSource(value === "全部来源" ? "" : value)} key={value}>
              {source === value && <Check/>}{value}
            </button>)}
          </fieldset>
          <fieldset><legend>职位状态</legend>
            {["全部状态", "待核验", "面试中", "Offer 阶段"].map(value => <button type="button"
              className={stage === value ? "selected" : ""}
              onClick={() => setStage(value === "全部状态" ? "" : value)} key={value}>
              {stage === value && <Check/>}{value}
            </button>)}
          </fieldset>
          <footer><button type="button" onClick={() => { setSource(""); setStage(""); }}>清除筛选</button><button type="button" onClick={() => setFiltersOpen(false)}>查看结果</button></footer>
        </div>}
      </div>
      <FilterSelect
        ariaLabel="职位排序"
        value={sort}
        onChange={setSort}
        options={[
          { value: "recommended", label: "推荐优先" },
          { value: "latest", label: "最新信号" },
          { value: "match", label: "匹配度最高" },
          { value: "evidence", label: "证据最完整" },
        ]}
      />
    </div>
    {activeFilters.length > 0 && <div className="filter-prototype-chips"><span>已选条件</span>
      {source && <button type="button" onClick={() => setSource("")}>来源：{source}<X/></button>}
      {stage && <button type="button" onClick={() => setStage("")}>状态：{stage}<X/></button>}
      <button className="clear" type="button" onClick={() => { setSource(""); setStage(""); }}>清除全部</button>
    </div>}
    <div className="filter-prototype-list">
      <article><i>01</i><div><b>训练 / 推理框架 Infra 工程师</b>
        <p>北京乾章科技 · 面试中 · TTC 职位系统</p></div><strong>推荐 92</strong></article>
      <article><i>02</i><div><b>机械结构工程师</b>
        <p>slash robotics · 面试中 · TTC 职位系统</p></div><strong>推荐 88</strong></article>
    </div>
  </section>;
}

export const FilterToolbarProposal: Story = {
  name: "筛选栏方案预览",
  args: { mode: "offline" },
  render: () => <FilterToolbarPrototype/>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /筛选/ }));
    const sourceOption = canvas.getByRole("button", { name: "驾驶舱" });
    await userEvent.hover(sourceOption);
    await userEvent.click(canvas.getByRole("button", { name: "职位排序" }));
    await userEvent.click(canvas.getByRole("option", { name: "最新信号" }));
    expect(canvas.getByRole("button", { name: "职位排序" })).toHaveTextContent("最新信号");
  },
};
