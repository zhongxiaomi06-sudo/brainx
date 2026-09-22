# 026 Plan — Server 登录与人才路由边界拆分

## 实现方案

1. 新增结构回归，锁定两个 route factory 的路由清单、入口组装方式和 500 行上限。
2. 将 OAuth/session/login 原样迁入 `auth-routes.js`，通过参数保留 `exchangeCode` 注入。
3. 将人才库与人才供给路由原样迁入 `talent-routes.js`，仓库根目录由入口显式传入。
4. `server.js` 仅合并 factory 返回值，保留统一开放路由清单、鉴权、错误收口和静态代理。
5. 删除质量门禁中 `src/server.js` 的存量行数例外，防止入口重新增长到 500 行以上。

## 兼容与回滚

- 不改变路由键、handler 参数顺序、状态码、错误码、Cookie 或重定向。
- 不改变数据库或持久层；回滚只需恢复内嵌组装，不涉及数据回滚。
- 若既有 HTTP 回归出现差异，停止并修复边界，不以更新快照接受差异。

## 验证

- `node --test tests/server-route-boundaries.test.mjs tests/oauth.test.mjs tests/server-routing.test.mjs tests/talent-backend-policy.test.mjs tests/talent.test.mjs`
- `npm run verify:quick`
- 提交后 `npm run verify`
