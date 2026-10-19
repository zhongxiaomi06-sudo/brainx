# specs/039 — CLI 判据输入支持文件（P3）

> 状态：建档待评审（2026-10-16，咪批准排入下一轮）
> 优先级：P3（工具改进，防操作层引号墙）

## 一、背景与问题证据

**今天实证的引号墙**（咪 2026-10-16 本地实验七连跑 + 项目既有纪律）：

- 同一判据穿 ssh+su 三层内联：11 → 58 字符（5.3× 膨胀）；刻意设计的 demo 对照组**两次都没能构造成功**（syntax error / No such file or directory）；file-run 4/4 一次成功。
- Node 层实测：`exec` 双引号包裹用户输入 → `$HOME` 被展开、反引号 `whoami` 真被执行；单引号包裹遇 payload 含 `'` 直接语法错误；`execFile` argv 数组原样到达。
- 项目既有纪律（memory 长期约定）：「嵌套引号过 SSH 必被逐层吃掉 → 一律落文件再跑」「heredoc 用 `<<'EOF'` 禁展开」。
- **代码层已治理**（咪 grep 实证）：src/bin 无 `exec`/`execSync`/`shell:true` 拼命令（0 处，命中全是 SQLite `db.exec` 与正则 `.exec`）；全仓唯一 heredoc（deploy/openclaw/install.sh:158）是 quoted `<<'EOF'` 合规。**剩下的坑全在操作层：人肉 ssh 敲 `--criteria "中文判据…"`。**

**代码层现状（2026-10-16 行号复核）**：

| 文件 | 现状 |
|---|---|
| `bin/brainx-supermai-search.mjs:60` | 默认 criteria 含中文+括号+顿号（`'3年以内经验，清华或北大，FA机构背景（光源资本、义柏资本、义凯资本、云岫资本、IO Investment），女生优先'`） |
| 同上 64 行 | `--criteria <text>` 走 argv 取值 |
| 同上 99 行 | `criteria.slice(0, 2000)` 落库 |
| `bin/brainx-auto-search-retrofill.mjs:106-113` | spawn argv 数组传 criteria（不过 shell，**无引号问题**） |

**缺口**：人肉通过 ssh 命令行传中文/引号/JSON 判据时仍会撞墙（单引号被吃、双引号展开、嵌套引号逐层丢失）。

## 二、设计（最小 diff）

### 2.1 `--criteria-file <path>`

```
--criteria-file <path>   从 UTF-8 文件读判据（与 --criteria 互斥，同时给报错退出）
```

- 读取：`readFileSync(path, 'utf8')`。
- **CRLF 剥离**（今日实验实证：CRLF 会让 shebang 炸 `/bin/bash^M: bad interpreter`；判据文本里的 `\r` 同样污染 hash 与 prompt）：`.replace(/\r\n?/g, '\n')` 后 trim。
- 空文件/纯空白 → 视为未提供，回落报错（与 criteria.length<5 的校验同语义）。
- 长度上限不变：仍 `slice(0, 2000)`（与 99 行现状一致），超长在 stderr 警告并截断（已有行为）。
- 互斥校验：`--criteria` 与 `--criteria-file` 同存 → 打印用法错误 exit 2（现有 `--help` 出口保持 exit 0）。
- 合成键不变：`supermaiCriteriaKey(criteria)` 仍按**文本内容**哈希——文件输入与内联输入同一判据文本得到同一 project_id（续搜/复用语义一致）。

### 2.2 不做的

- **不做 stdin 模式**（`--criteria-file -`）：echo/heredoc 进 stdin 同样有 quoting 面，且与「文件可 diff、可进 git、可 review」的核心价值相悖；保持最小面。
- 不改 retrofill 的 spawn 传参（argv 数组本无引号问题）。
- 不改 `criteria.slice(0,2000)` 上限语义。

### 2.3 帮助文本与文档

- `--help` 输出加一行用法 + 一个示例（`--criteria-file /tmp/criteria.txt`）。
- 帮助文本注明：「判据含中文/引号/JSON 时推荐文件输入，避免 SSH 多层转义」。

## 三、深度审核记录（2026-10-16）

### 3.1 边界用例

| # | 场景 | 预期 |
|---|---|---|
| 1 | `--criteria-file` + `--criteria` 同给 | exit 2 + 用法错误 |
| 2 | 文件含 CRLF | 剥离后按 LF 文本处理，hash 与纯 LF 输入一致 |
| 3 | 文件 UTF-8 中文 | 原样读入（Node readFileSync utf8，无 BOM 处理需求——带 BOM 时 trim 不掉，判据首字符异常但不崩；**接受**，文档注明用无 BOM UTF-8） |
| 4 | 空文件/纯空白 | 报错退出（同 criteria 过短） |
| 5 | 文件不存在 | readFileSync 抛错 → 友好报错 exit 1（包 try/catch，不让堆栈裸抛） |
| 6 | 判据 >2000 字符 | 截断 + stderr 警告（现状不变） |
| 7 | 同判据文本 file vs 内联 | project_id 一致（hash 同文本）→ done 复用/续搜排除名单打通 |
| 8 | 路径含空格/中文 | argv 传路径无 shell，readFileSync 直接吃（无引号问题） |
| 9 | retrofill spawn 路径 | 不改（argv 数组无quoting 面） |
| 10 | `--help` | 含新参数说明，exit 0 |

### 3.2 回归风险

- 现有 `--criteria` 行为零变化（默认值、解析、hash、落库全不变）→ 回归面仅新增分支。
- 测试：`tests/` 无 CLI 参数单测先例（bin/ 脚本现有集成测模式）→ 用临时目录 fixture（LF / CRLF / 空 / 超长 / 不存在五例）+ 一次「file 输入 → 同 hash 复用」断言。

### 3.3 验收标准

1. 五类 fixture 单测全绿；`--criteria` 旧行为回归绿。
2. 人肉场景实证：`ssh host "su -s /bin/bash brainx -c 'cd /opt/brainx && /usr/bin/node bin/brainx-supermai-search.mjs --criteria-file /tmp/c.txt --consultant felix'"`（判据含中文+引号+JSON）→ 落库 search_brief 与文件内容逐字一致。
3. `npm run verify` 全绿。

## 四、与今日认知的对应

- 「传输走数据通道（字节），执行走代码通道（一次解析）」——文件输入让判据以字节形态穿过 ssh/su，不被任何一层 shell 解析。
- 行业同款：download→verify→execute（curl|bash 反模式的标准对策）、`ssh host 'bash -s' < script.sh`、Ansible script vs shell 模块、Dockerfile COPY vs `sh -c`。
