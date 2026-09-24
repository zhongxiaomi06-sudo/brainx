"use client";

import { useCallback, useEffect, useState } from "react";
import { ConnectionCenter } from "./connection-center";
import {
  getConnections,
  startSupermaiLogin,
  type ProviderConnection,
  type SupermaiPlatform,
} from "./brainx-connections-api";

type Notify = (message: string, options?: {
  actions?: { label: string; onClick: () => void }[];
  input?: { placeholder: string; onSubmit: (text: string) => void };
}, duration?: number) => void;

function Sources({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyPlatform, setBusyPlatform] = useState<SupermaiPlatform | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await getConnections(signal);
      setItems(response.items);
      setError("");
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "连接状态读取失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const interval = window.setInterval(() => void refresh(controller.signal), 5_000);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(interval); };
  }, [refresh]);

  const launch = async (platform: SupermaiPlatform) => {
    setBusyPlatform(platform);
    try {
      await startSupermaiLogin(platform);
      notify("官方登录页已打开。登录完成后，BrainX 会自动刷新连接状态。", undefined, 5000);
      window.setTimeout(() => void refresh(), 1_500);
    } catch (cause) {
      notify(`未能打开官方登录页：${cause instanceof Error ? cause.message : "本机 SuperMai 未就绪"}`, undefined, 5000);
    } finally {
      setBusyPlatform(null);
    }
  };

  return <ConnectionCenter
    items={items}
    loading={loading}
    error={error}
    busyPlatform={busyPlatform}
    onRefresh={() => void refresh()}
    onStartSupermai={platform => void launch(platform)}
    onReauthorizeFeishu={() => { window.location.assign("/api/v1/oauth/authorize"); }}
  />;
}

export default Sources;
