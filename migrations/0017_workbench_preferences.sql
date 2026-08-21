-- 0017_workbench_preferences.sql — 当前顾问工作台偏好持久化
-- 精选盘 / 文件夹等 UI 工作区状态按 consultant_id 入库，避免刷新或换设备后丢失。

CREATE TABLE IF NOT EXISTS workbench_preferences (
  consultant_id TEXT PRIMARY KEY,
  tray_json     TEXT NOT NULL DEFAULT '[]',
  folders_json  TEXT NOT NULL DEFAULT '[]',
  folder_mode   INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
