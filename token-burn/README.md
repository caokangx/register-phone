# Token Burn

批量克隆 GitHub 中大型开源仓库，并通过 [Claude Code](https://code.claude.com/) 在同一会话上下文中顺序执行 30 条循序渐进的源码分析任务。

主要用于：**自动化、长时间、大批量地跑 Claude Code 分析流程**（会消耗大量 token，请注意费用）。

---

## 新环境一键启动

在新的命令行环境里，复制粘贴**一条命令**即可完成：克隆仓库 → 重置 3 天窗口 → 安装 cron（每天 10 轮）→ 立刻跑一轮：

```bash
git clone https://github.com/caokangx/register-phone.git ~/Documents/register-phone && ~/Documents/register-phone/token-burn/bootstrap.sh --now --immediate
```

仓库已存在时，只需：

```bash
~/Documents/register-phone/token-burn/bootstrap.sh --now --immediate
```

## 查看状态

```bash
~/Documents/register-phone/token-burn/status.sh
```

其他选项：

```bash
# 只初始化 + 装 cron，不立刻跑
~/Documents/register-phone/token-burn/bootstrap.sh

# 立刻跑一轮
~/Documents/register-phone/token-burn/bootstrap.sh --now --immediate

# 不重置 3 天窗口、不改 cron
~/Documents/register-phone/token-burn/bootstrap.sh --no-reset --no-cron
```

前置条件：已安装并登录 `claude`、`git`、`python3`。

首次运行会自动从 `env.example.sh` 生成 `env.sh`（含 `HOME`、`PATH`、代理配置）。**Cron 不会读取你终端里的环境变量**，见下文说明。

---

## 3 天定时任务（最常用）

**需求**：连续 **3 天**，每天 **10 轮**，每半小时随机选一个仓库后台执行 30 条任务；第 4 天起自动停止。

| Cron 触发 | 间隔 | 每天轮数 | 实际开工时段 |
|-----------|------|----------|--------------|
| 每天 **9:00–13:30** | 每 30 分钟 | **10 轮** | **9:00、9:30、...、13:30** |

3 天共最多 **30 次**仓库任务（每天 10 次 × 3 天）。

### 第一步：加入 crontab

```bash
crontab -e
```

粘贴下面**一行**：

```bash
0,30 9-13 * * * ~/Documents/register-phone/token-burn/run-daily-campaign.sh >> ~/Documents/register-phone/token-burn/logs/campaign.log 2>&1
```

或用 `bootstrap.sh` 自动安装（会删掉旧的单行 cron）：

```bash
~/Documents/register-phone/token-burn/bootstrap.sh
```

### 第二步：确认状态

```bash
cd ~/Documents/register-phone/token-burn

# 推荐：一条命令看全部（3 天窗口 + 任务进度 + Token 消耗）
./status.sh

# 仅看 Token / 费用汇总（解析 logs/task_*.log 里的 Claude JSON result）
python3 aggregate-usage.py
python3 aggregate-usage.py --project nextjs
python3 aggregate-usage.py --json

# 仅看 3 天 campaign 窗口（runs 只有走 run-daily-campaign.sh 才会记录）
./run-daily-campaign.sh --status

# 看当前正在跑的项目任务进度（1/30、2/30 …）
./<项目名>/run.sh --status          # 例如 ./redis/run.sh --status
tail -f <项目名>/logs/main.log       # 例如 tail -f redis/logs/main.log

# 最近一次随机抽选
cat last-random.json

# 哪些项目在后台运行
./run-random.sh --list
```

### 行为说明

| 项 | 说明 |
|----|------|
| 持续天数 | 从**首次触发**起连续 3 个自然日（含当天） |
| 每天次数 | **10 次**（9:00–13:30 每半小时 1 次，各随机 1 个仓库） |
| 触发频率 | cron `0,30 9-13 * * *`，每次触发立即开工 |
| 每日上限 | 当天已跑满 10 轮后，后续触发会跳过 |
| 抽选规则 | 调用 `run-random.sh` 随机选一个项目 |
| 状态文件 | `campaign.json`（起止日期、历史运行记录） |
| 任务进度 | `<项目>/progress.json`（当前第几条 / 30） |
| 日志 | `logs/campaign.log`、`<项目>/logs/main.log` |

> **注意**：`campaign.json` 的 `runs` 每条会带 `run_number`。`--status` 可看到当天已完成轮数和剩余轮数。

### Cron 与环境变量（重要）

**Cron 不会自动读取你交互式 shell 的环境变量。**

| 变量 | 为什么不传会出问题 |
|------|-------------------|
| `HOME` | `claude` 配置、凭证通常在 `$HOME/.claude` |
| `PATH` | Cron 默认 PATH 很短，找不到 `~/.local/bin/claude` |
| `http_proxy` / `https_proxy` | 不会继承终端里的代理，git clone / API 可能失败 |

你在终端里 `export` 过的变量，**Cron 任务里默认都没有**（不读 `~/.bashrc`、`~/.zshrc`）。

**推荐做法**（已内置）：编辑 `token-burn/env.sh`：

```bash
cp ~/Documents/register-phone/token-burn/env.example.sh ~/Documents/register-phone/token-burn/env.sh
# 按机器修改 HOME、代理地址
```

`run-daily-campaign.sh` / `run-random.sh` / 各项目 `run.sh` 启动时会自动 `source env.sh`，**无需在 crontab 里再手写 export**。

若仍想在 crontab 里显式写（等价做法）：

```bash
0,30 9-13 * * * export HOME=/home/coder PATH=/home/coder/.local/bin:/usr/local/bin:/usr/bin:/bin http_proxy=http://192.168.3.100:1084 https_proxy=http://192.168.3.100:1084; ~/Documents/register-phone/token-burn/run-daily-campaign.sh >> ~/Documents/register-phone/token-burn/logs/campaign.log 2>&1
```

---

## 前置要求

| 依赖 | 说明 |
|------|------|
| [Claude Code CLI](https://code.claude.com/) | 已安装且已登录，`claude` 在 PATH 中 |
| `git` | 用于浅克隆仓库 |
| `python3` | 用于运行生成器、写入进度 JSON |
| 磁盘空间 | 10 个大型仓库浅克隆仍需数 GB～数十 GB |
| API 额度 | 每个项目 30 任务；3 天 campaign 最多 30 个项目轮次 = **900 次** `claude -p` 调用 |

---

## 目录结构

```
token-burn/
├── README.md              # 本文件
├── REGENERATE_PROMPT.md   # 换仓库时给 AI 用的完整 Prompt
├── generate.py            # 一键生成/再生成全部文件
├── manifest.json          # 当前批次项目清单
├── run-random.sh          # 随机选一个项目运行
├── run-daily-campaign.sh  # 3 天定时：每天 9:00–13:30 每半小时一轮
├── bootstrap.sh           # 新环境一键初始化 + 启动
├── aggregate-usage.py     # 从 task_*.log 汇总 token / 费用
├── status.sh              # 统一状态（含 token 统计）
├── run-all.sh             # 批量调度所有项目
│
├── kubernetes/            # 每个项目一个目录
│   ├── tasks.txt          #   30 条 Claude Code 任务（每行一条）
│   ├── run.sh             #   单项目执行脚本
│   ├── workspace/         #   运行时：克隆的仓库（自动生成）
│   └── logs/              #   运行时：日志与进度（自动生成）
│       ├── main.log
│       ├── task_001.log … task_030.log
│       └── progress.json  #   实际写在项目根目录
│
├── golang/
├── react/
└── …（共 10 个项目）
```

---

## 当前批次项目

| 目录 | 仓库 | 领域 |
|------|------|------|
| `kubernetes/` | [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) | 容器编排 |
| `golang/` | [golang/go](https://github.com/golang/go) | 编译器与运行时 |
| `react/` | [facebook/react](https://github.com/facebook/react) | UI 并发渲染 |
| `nextjs/` | [vercel/next.js](https://github.com/vercel/next.js) | 全栈框架 |
| `redis/` | [redis/redis](https://github.com/redis/redis) | 内存数据库 |
| `prometheus/` | [prometheus/prometheus](https://github.com/prometheus/prometheus) | 时序监控 |
| `grpc-go/` | [grpc/grpc-go](https://github.com/grpc/grpc-go) | RPC 框架 |
| `kafka/` | [apache/kafka](https://github.com/apache/kafka) | 流处理 |
| `pytorch/` | [pytorch/pytorch](https://github.com/pytorch/pytorch) | 深度学习 |
| `istio/` | [istio/istio](https://github.com/istio/istio) | 服务网格 |

完整元数据见 [`manifest.json`](./manifest.json)。

---

## 快速开始

### 随机运行一个项目（推荐）

每次从 10 个项目里**随机挑一个**后台执行：

```bash
cd ~/Documents/register-phone/token-burn
./run-random.sh
```

其他用法：

```bash
# 先看会抽到哪个，不真正启动
./run-random.sh --dry-run

# 跳过已在后台运行的项目，只从空闲项目里抽
./run-random.sh --skip-running

# 列出所有可选项目
./run-random.sh --list

# 前台运行（占用当前终端）
./run-random.sh --foreground

# 停止最近一次随机启动的项目
./run-random.sh --stop

# 停止所有正在后台运行的项目
./run-random.sh --stop-all
```

最近一次抽选记录在 `last-random.json`：

```bash
cat last-random.json
```

如需**仅手动**随机跑一次（不限 3 天），用 `./run-random.sh` 即可。

### 运行指定项目（后台）

```bash
cd ~/Documents/register-phone/token-burn/kubernetes
./run.sh --background
```

脚本会自动：

1. 浅克隆 `kubernetes/kubernetes` 到 `workspace/kubernetes/`
2. 按 `tasks.txt` 顺序执行 30 条 `claude -p` 任务
3. 通过 `--resume` / `--continue` 保持同一会话上下文

### 查看进度

```bash
./run.sh --status
tail -f logs/main.log
tail -f logs/task_042.log   # 查看某一任务的详细输出
```

`progress.json` 示例：

```json
{
  "project": "kubernetes",
  "current": 42,
  "total": 30,
  "percent": 42.0,
  "status": "running",
  "last_task": "【任务 12/30 · …】",
  "updated_at": "2026-06-27T08:00:00Z",
  "pid": 12345
}
```

### 停止任务

```bash
./run.sh --stop
```

### 运行全部项目

```bash
cd ~/Documents/register-phone/token-burn

# 顺序执行（一个跑完再跑下一个）
./run-all.sh

# 后台并行 3 个项目
./run-all.sh --parallel 3

# 查看所有项目进度
./run-all.sh --status

# 停止全部
./run-all.sh --stop-all
```

---

## 任务设计（每个项目 30 条）

任务由浅入深，分 7 个阶段：

| 阶段 | 编号 | 内容 |
|------|------|------|
| 架构分析 | 1–5 | 模块边界、依赖、调用链、配置、测试 |
| 深度源码 | 6–10 | 精读、并发、错误处理、生命周期 |
| 性能扫描 | 11–15 | 热点、I/O、缓存、批处理、基准 |
| 瓶颈识别 | 16–20 | 瓶颈假设、锁竞争、内存、网络 |
| 优化方案 | 21–24 | 详细方案、优先级排序 |
| 优化执行 | 25–28 | 代码审查、重构草案、观测增强 |
| 验证报告 | 29–30 | 测试计划、最终报告 |

任务以**分析、方案、审查**为主，不要求修改上游仓库或提交 PR。

---

## 配置与费用控制

各项目 `run.sh` 中的 Claude 参数：

```bash
CLAUDE_BIN="${CLAUDE_BIN:-claude}"   # 可指定 claude 路径
CLAUDE_FLAGS=(
  --permission-mode auto              # 自动批准工具调用
  --max-turns 50                      # 单任务最大轮次
)
# 取消注释以限制单任务费用：
# CLAUDE_FLAGS+=(--max-budget-usd 2)
```

工作目录可通过环境变量覆盖：

```bash
WORK_DIR=/path/to/large-disk ./kubernetes/run.sh --background
```

---

## 换一批新仓库

### 方式 A：手动改生成器

1. 编辑 [`generate.py`](./generate.py) 中的 `PROJECTS` 数组
2. （可选）备份或删除旧的项目子目录
3. 重新生成：

```bash
cd ~/Documents/register-phone/token-burn
python3 generate.py
```

### 方式 B：让 AI 重新生成

打开 [`REGENERATE_PROMPT.md`](./REGENERATE_PROMPT.md)，复制其中的「完整 Prompt」，按需修改项目数量、领域偏好后发给 Cursor / Claude Code。

---

## `run-daily-campaign.sh` 命令参考

| 命令 | 说明 |
|------|------|
| `./run-daily-campaign.sh` | 立即执行一轮（若当天未满 10 轮） |
| `./run-daily-campaign.sh --status` | 查看 3 天窗口、runs、当天已跑/剩余轮数 |
| `./run-daily-campaign.sh --dry-run` | 预览本轮会抽哪个仓库 |
| `./run-daily-campaign.sh --reset` | 重置，从今天起重新计 3 天 |

## `run-random.sh` 命令参考

| 命令 | 说明 |
|------|------|
| `./run-random.sh` | 随机选一个项目，后台运行 |
| `./run-random.sh --dry-run` | 只抽签，不启动 |
| `./run-random.sh --skip-running` | 跳过已在运行的项目 |
| `./run-random.sh --list` | 列出所有可选项目 |
| `./run-random.sh --foreground` | 随机选中后前台运行 |
| `./run-random.sh --stop` | 停止最近一次随机启动的项目 |
| `./run-random.sh --stop-all` | 停止所有正在后台运行的项目 |

## `run.sh` 命令参考

| 命令 | 说明 |
|------|------|
| `./run.sh` | 前台执行（克隆 + 30 条任务） |
| `./run.sh --background` | 后台执行，写入 PID 和日志 |
| `./run.sh --status` | 查看 `progress.json` |
| `./run.sh --stop` | 停止后台进程 |
| `./run.sh --foreground` | 显式前台（供 nohup 内部调用） |

## `run-all.sh` 命令参考

| 命令 | 说明 |
|------|------|
| `./run-all.sh` | 顺序跑完全部项目 |
| `./run-all.sh --parallel N` | 最多 N 个项目同时后台运行 |
| `./run-all.sh --status` | 汇总所有项目进度 |
| `./run-all.sh --stop-all` | 停止全部后台任务 |

---

## 注意事项

- **费用**：3 天 campaign 最多跑 900 条任务，仍可能产生较高 API 费用，建议先用单个项目试跑，并启用 `--max-budget-usd`。
- **时间**：大型仓库（PyTorch、Kubernetes）单次克隆和分析都可能耗时数小时。
- **网络**：克隆 GitHub 仓库需要稳定网络；失败后可重新运行，已克隆的仓库会复用。
- **上下文**：同项目内 30 条任务共享会话；跨项目之间上下文不共享。
- **不要提交 `workspace/` 和 `logs/`**：这些是运行时产物，体积大且无需版本管理。

---

## 相关文件

| 文件 | 用途 |
|------|------|
| [`generate.py`](./generate.py) | Python 生成器，维护项目列表和任务模板 |
| [`REGENERATE_PROMPT.md`](./REGENERATE_PROMPT.md) | 给 AI 用的完整再生成 Prompt |
| [`manifest.json`](./manifest.json) | 当前批次项目元数据 |
| [`run-random.sh`](./run-random.sh) | 随机选一个项目运行 |
| [`last-random.json`](./last-random.json) | 最近一次随机抽选记录（运行时生成） |

---

## License

本工具集为本地自动化脚本，所克隆的第三方仓库遵循各自的开源协议。
