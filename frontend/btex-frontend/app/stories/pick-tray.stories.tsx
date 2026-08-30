import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PickTray } from "../workbench-pick-tray";
import {
  DEFAULT_FOLDERS,
  decisionJobs,
  type PickFolder,
} from "../workbench-model";

const meta = {
  title: "业务组件/已收藏职位",
  parameters: {
    docs: {
      description: {
        component: "使用状态容器驱动真实 PickTray，覆盖移除、推荐与文件夹模式。",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function PickTrayHarness({
  initialIds = decisionJobs.slice(0, 2).map((job) => job.id),
  initialFolderMode = false,
  showRecommendations = true,
}: {
  initialIds?: string[];
  initialFolderMode?: boolean;
  showRecommendations?: boolean;
}) {
  const [ids, setIds] = useState(initialIds);
  const [folderMode, setFolderMode] = useState(initialFolderMode);
  const [folders, setFolders] = useState<PickFolder[]>(DEFAULT_FOLDERS);
  const trayJobs = useMemo(
    () => decisionJobs.filter((job) => ids.includes(job.id)),
    [ids],
  );
  const toggle = (id: string) => {
    setIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  };
  const assignFolder = (jobId: string, folderId: string) => {
    setFolders((current) => current.map((folder) => ({
      ...folder,
      jobIds: folder.id === folderId
        ? [...new Set([...folder.jobIds, jobId])]
        : folder.jobIds.filter((id) => id !== jobId),
    })));
  };
  return (
    <PickTray
      trayJobs={trayJobs}
      featuredJobs={showRecommendations ? decisionJobs.slice(0, 4) : []}
      allJobs={decisionJobs}
      folderMode={folderMode}
      onFolderMode={() => setFolderMode((value) => !value)}
      folders={folders}
      onRemoveTray={(id) => setIds((current) => current.filter((item) => item !== id))}
      onToggleTray={toggle}
      onAssignFolder={assignFolder}
      onCreateFolder={(name) => setFolders((current) => [
        ...current,
        { id: `story-${current.length + 1}`, name, jobIds: [] },
      ])}
      open={() => undefined}
    />
  );
}

export const SelectedJobs: Story = {
  render: () => <PickTrayHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const remove = canvas.getAllByRole("button", { name: /从已收藏移除/ })[0];
    const company = remove.getAttribute("aria-label")?.replace("从已收藏移除 ", "") || "";
    await userEvent.click(remove);
    await expect(canvas.queryByText(company)).not.toBeInTheDocument();
    await expect(canvas.getByText("1 已收藏")).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "确定" })).not.toBeInTheDocument();
  },
};

export const RecommendationPreview: Story = {
  render: () => <PickTrayHarness initialIds={[]} />,
};

export const FolderMode: Story = {
  render: () => <PickTrayHarness initialFolderMode />,
};

export const Empty: Story = {
  render: () => <PickTrayHarness initialIds={[]} showRecommendations={false} />,
};
