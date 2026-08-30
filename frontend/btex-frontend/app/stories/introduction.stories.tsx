import type { Meta, StoryObj } from "@storybook/react-vite";

function Introduction() {
  return (
    <article className="storybook-introduction">
      <p className="eyebrow">INTERNAL UI CATALOG</p>
      <h1>BrainX 内部组件库</h1>
      <p>把真实工作台组件放进可独立查看、交互和验收的环境。</p>
      <h2>使用原则</h2>
      <ul>
        <li>Story 直接引用生产组件，不复制另一套演示实现。</li>
        <li>每个业务组件覆盖默认、空、异常或边界状态。</li>
        <li>数据通过属性或本地样例注入，不连接生产接口。</li>
        <li>关键交互使用自动化步骤验证用户真正能点击和选择。</li>
        <li>可访问性面板持续展示键盘、语义和对比度问题。</li>
      </ul>
      <h2>当前目录</h2>
      <dl>
        <div><dt>基础控件</dt><dd>标题、状态标签、下拉选择、分段切换、抽屉区块</dd></div>
        <div><dt>业务组件</dt><dd>精选盘队列、已收藏职位、文件夹、事实编辑、判断规则</dd></div>
        <div><dt>流程组件</dt><dd>开始跟进、进展、阻塞、终局、释放编辑器与行动闭环</dd></div>
        <div><dt>应用外壳</dt><dd>完整工作台、错误边界、错误降级界面与 Dino 游戏</dd></div>
      </dl>
    </article>
  );
}

const meta = {
  title: "指南/开始使用",
  component: Introduction,
  parameters: { layout: "centered", controls: { disable: true } },
} satisfies Meta<typeof Introduction>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
