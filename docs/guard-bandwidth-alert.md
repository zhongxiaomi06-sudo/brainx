# 请求带宽/调用量预测告警装置（brainx-guard）

## 是什么

对 BrainX 的**入站请求速率**与**带宽**做预测式监控：server 内置 60s 滚动桶指标
（请求数、入/出字节、按路由计数——只有聚合数字，无任何业务数据），看门狗轮询
`GET /api/v1/meta/guard`，用 EWMA 基线外推检测三类异常并告警：

| 检测项 | 触发条件（默认） | 防什么 |
|---|---|---|
| 绝对阈值 | 请求速率 > 600 rpm 或带宽 > 5 MB/s | 基础洪峰 |
| 相对突增（预测） | 当前速率 > 基线 × 3 且 > 30 rpm | 突发流量爆炸（如 9 worker 同时全量拉取） |
| 单路由洪峰 | 某路由 > 240 rpm（如 `GET /api/v1/jobs/snapshot`） | 快照接口被并发打爆 |

## 用法

```bash
# 持续盯（默认本地 :3000，每 30s 一轮；退出码 2=告警 0=正常 1=探测失败）
node bin/brainx-guard.mjs --url http://127.0.0.1:3101 --interval 30

# 盯远程服务器 + 推飞书群 webhook
node bin/brainx-guard.mjs --url https://base.yorkteam.cn --webhook https://open.feishu.cn/open-apis/bot/v2/hook/<id>

# 单次检查（适合 cron：告警时退出码 2，可接告警平台）
node bin/brainx-guard.mjs --once

# 实测：起临时服务模拟 400 次突发请求，验证告警真的会触发
node bin/brainx-guard.mjs --selftest
```

参数：`--max-rpm` `--max-bps`（字节/秒）`--spike-mult` `--max-route-rpm` `--webhook`。
webhook 也可用环境变量 `BRAINX_GUARD_WEBHOOK` 配置。

## 实测记录（2026-08-21）

```
[selftest] 突发 400 请求 / 1.0s → rpm=417 路由={"GET /api/v1/meta/guard":17,"GET /api/v1/jobs/snapshot":400}
✅ [selftest] 告警已触发：
   - 请求速率 417 rpm 超绝对阈值 300 rpm
   - 请求速率突增：417 rpm ≈ 基线 136.3 rpm 的 3.1 倍（> 2×）
   - 路由洪峰 GET /api/v1/jobs/snapshot：400 rpm 超 200 rpm
```

单元 + 集成测试见 `tests/guard.test.mjs`（8 例，全量套件 244 通过）。

## 数据源

`GET /api/v1/meta/guard`（免登录，仅聚合计数）。响应含当前 60s 桶
`per_minute`（total / bytes_in / bytes_out / by_route）与最近 6 分钟 `history`。
