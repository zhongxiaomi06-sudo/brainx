import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Check, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
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
  const [status, setStatus] = useState("招聘中");
  const [sort, setSort] = useState("recommended");
  const activeFilters = [source && `来源：${source}`, status && `状态：${status}`].filter(Boolean);
  return <section className="filter-prototype-card">
    <div className="filter-prototype-notice"><b>审核原型</b><span>字段结构来自真实数据库；以下示例值已匿名化，不代表线上客户或职位。</span></div>
    <header><div><span>DECISION QUEUE</span><h2>待判断职位</h2></div><strong>2 个示例</strong></header>
    <div className="filter-prototype-toolbar">
      <label><Search/><input aria-label="搜索职位或公司" placeholder="搜索职位、公司或关键词"/></label>
      <div className="filter-prototype-filter-wrap">
        <button className={filtersOpen ? "is-active" : ""} type="button" onClick={() => setFiltersOpen(value => !value)} aria-expanded={filtersOpen}>
          <SlidersHorizontal/>筛选{activeFilters.length > 0 && <i>{activeFilters.length}</i>}
        </button>
        {filtersOpen && <div className="filter-prototype-popover">
          <div><b>筛选职位</b><button type="button" onClick={() => setFiltersOpen(false)} aria-label="关闭筛选"><X/></button></div>
          <fieldset><legend>数据来源</legend>
            {["全部来源", "TTC 职位系统", "飞书职位盘点"].map(value => <button type="button"
              className={source === value ? "selected" : ""}
              onClick={() => setSource(value === "全部来源" ? "" : value)} key={value}>
              {source === value && <Check/>}{value}
            </button>)}
          </fieldset>
          <fieldset><legend>招聘状态</legend>
            {["全部状态", "招聘中", "冷却期", "已关闭", "待确认"].map(value => <button type="button"
              className={status === value ? "selected" : ""}
              onClick={() => setStatus(value === "全部状态" ? "" : value)} key={value}>
              {status === value && <Check/>}{value}
            </button>)}
          </fieldset>
          <footer><button type="button" onClick={() => { setSource(""); setStatus(""); }}>清除筛选</button><button type="button" onClick={() => setFiltersOpen(false)}>查看结果</button></footer>
        </div>}
      </div>
      <FilterSelect
        ariaLabel="职位排序"
        value={sort}
        onChange={setSort}
        options={[
          { value: "recommended", label: "推荐顺序" },
          { value: "latest", label: "最近同步" },
          { value: "hc", label: "剩余 HC" },
        ]}
      />
    </div>
    {activeFilters.length > 0 && <div className="filter-prototype-chips"><span>已选条件</span>
      {source && <button type="button" onClick={() => setSource("")}>来源：{source}<X/></button>}
      {status && <button type="button" onClick={() => setStatus("")}>状态：{status}<X/></button>}
      <button className="clear" type="button" onClick={() => { setSource(""); setStatus(""); }}>清除全部</button>
    </div>}
    <div className="filter-prototype-sources" aria-label="字段来源说明">
      <span><b>职位事实</b> job_facts</span><span><b>顾问关系</b> job_memberships</span>
      <span><b>规则建议</b> recommendations</span>
    </div>
    <div className="filter-prototype-list">
      <article className="standard-job-card">
        <div className="standard-job-identity"><i>01</i><div>
          <small>TTC · JOB-EXAMPLE-001</small><b>岗位名称示例</b><p>示例客户 A</p>
        </div></div>
        <dl className="standard-job-facts">
          <div><dt>城市</dt><dd>北京市</dd></div><div><dt>招聘状态</dt><dd>招聘中</dd></div>
          <div><dt>剩余 HC</dt><dd>2</dd></div><div><dt>顾问关系</dt><dd>团队共享</dd></div>
          <div className="wide"><dt>Pipeline</dt><dd>推荐 5 · 面试 1 · 寻访 3</dd></div>
          <div className="wide"><dt>最近同步</dt><dd>2026-08-26</dd></div>
        </dl>
        <div className="standard-job-decision"><small>规则建议</small><b>先核验，再决定是否推进</b>
          <p>可用判断信号 3/6</p><em>缺失：方向画像、历史相似、历史结果</em>
          <button type="button">核验关键事实<ChevronRight/></button>
        </div>
        <footer>事实：TTC 职位库 · 关系：BrainX 项目关系 · 建议：规则引擎</footer>
      </article>
      <article className="standard-job-card is-incomplete">
        <div className="standard-job-identity"><i>02</i><div>
          <small>飞书 · JOB-EXAMPLE-002</small><b>职位名称待补充</b><p>示例客户 B</p>
        </div></div>
        <dl className="standard-job-facts">
          <div><dt>城市</dt><dd>待确认</dd></div><div><dt>招聘状态</dt><dd>待确认</dd></div>
          <div><dt>剩余 HC</dt><dd>待确认</dd></div><div><dt>顾问关系</dt><dd>我的职位</dd></div>
          <div className="wide"><dt>Pipeline</dt><dd>暂无记录</dd></div>
          <div className="wide"><dt>最近同步</dt><dd>2026-08-26</dd></div>
        </dl>
        <div className="standard-job-decision"><small>规则建议</small><b>先补齐职位事实</b>
          <p>可用判断信号 2/6</p><em>缺失字段不会折算成 0 分</em>
          <button type="button">补充职位事实<ChevronRight/></button>
        </div>
        <footer>缺失信息按“待确认”展示，不生成替代分数</footer>
      </article>
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
    const sourceOption = canvas.getByRole("button", { name: "飞书职位盘点" });
    await userEvent.hover(sourceOption);
    await userEvent.click(canvas.getByRole("button", { name: "职位排序" }));
    await userEvent.click(canvas.getByRole("option", { name: "最近同步" }));
    expect(canvas.getByRole("button", { name: "职位排序" })).toHaveTextContent("最近同步");
    expect(canvas.queryByText("AI 匹配分")).not.toBeInTheDocument();
    expect(canvas.queryByText("探索价值")).not.toBeInTheDocument();
    expect(canvas.getByText("缺失字段不会折算成 0 分")).toBeInTheDocument();
  },
};
