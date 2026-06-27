# Token Burn 仓库指令 — 再生成 Prompt

> 用途：不定期换一批 GitHub 仓库和任务时，把下面「完整 Prompt」整段复制给 Cursor / Claude Code，即可按同一规范重新生成整套文件。
>
> 输出目录固定：`~/Documents/register-phone/token-burn/`

---

## 快速再生成（仅换仓库列表时）

若只需替换项目、任务模板和脚本结构不变：

1. 编辑 `generate.py` 里的 `PROJECTS` 数组（换 `id` / `name` / `repo` / `domain` / `areas` / `topics`）
2. 删除或备份旧的项目子目录（如 `kubernetes/`、`golang/` 等）
3. 运行：

```bash
cd ~/Documents/register-phone/token-burn
python3 generate.py
```

---

## 完整 Prompt（复制给 AI）

```
我需要你帮我生成一套「Claude Code 批量消耗 token」的仓库分析任务，规范如下。

## 目标

1. 从 GitHub 挑选 N 个有技术难度的中大型开源项目（默认 10 个，领域尽量多样：系统、语言、前端、数据库、RPC、流处理、AI、服务网格等）
2. 针对每个项目生成 100 条循序渐进的 Claude Code 自然语言任务（不是 shell 命令，是给 `claude -p` 用的 prompt）
3. 为每个项目生成一个可执行的 `run.sh`，以及顶层的 `run-all.sh` 和 `manifest.json`
4. 所有文件输出到统一目录：`~/Documents/register-phone/token-burn/`

## 每个项目的元数据结构

每个项目在 `generate.py` 的 PROJECTS 数组中应包含：

- `id`：目录名（小写、短横线，如 `grpc-go`）
- `name`：显示名称
- `repo`：GitHub clone URL（https://github.com/org/repo.git）
- `domain`：一句话领域描述（中文）
- `areas`：10 个左右核心源码目录路径（用于轮换引用）
- `topics`：12 个左右技术主题（用于轮换引用）

## 100 条任务的阶段划分（每个项目固定）

按任务编号 1–100 分 7 个阶段，每条任务必须标注「任务 X/100」和阶段类型：

| 阶段 | 编号 | 类型 tag | 内容方向 |
|------|------|----------|----------|
| 架构分析 | 1–15 | 架构分析 / 依赖梳理 / 调用链追踪 / 配置审计 / 测试覆盖 | 读目录结构、模块边界、import 关系、配置项、测试用例 |
| 深度源码 | 16–30 | 源码精读 / 并发模型 / 错误处理 / 内存与生命周期 / 扩展点 | 精读核心文件、锁与并发、错误模式、对象生命周期 |
| 性能扫描 | 31–45 | 性能热点扫描 / I/O 路径 / 缓存策略 / 批处理机会 / 基准测试 | 找热点、分析 I/O、审查 cache、设计 benchmark |
| 瓶颈识别 | 46–60 | 瓶颈假设 / 火焰图假想 / 锁竞争 / 内存分配 / 网络往返 | 列瓶颈、推测 profiling 结果、减锁方案 |
| 优化方案 | 61–75 | 优化方案 A–D / 优化优先级 | 写详细方案、伪代码对比、ICE 优先级矩阵 |
| 优化执行 | 76–90 | 代码审查 / 重构草案 / 配置调优 / 降级策略 / 观测增强 | 逐行审查、重构建议、metrics/tracing 方案 |
| 验证报告 | 91–100 | 回归测试计划 / 性能对比 / 文档更新 / 技术债清单 / 最终报告 | 测试计划、A/B 实验设计、全景报告 |

任务生成规则：
- 从 `areas` 和 `topics` 轮换取值，使 100 条内容不重复
- 每条 prompt 应鼓励 Claude 大量读文件、搜索、分析（以消耗 token 为主要目的）
- 不要要求真正修改上游仓库或提交 PR，以「分析、方案、审查」为主
- 使用中文撰写任务描述

## 每个项目的目录结构

```
token-burn/
├── generate.py           # Python 生成器（PROJECTS 数组 + 模板逻辑）
├── REGENERATE_PROMPT.md  # 本文件
├── manifest.json         # 项目清单
├── run-all.sh            # 批量调度
└── {project-id}/
    ├── tasks.txt         # 100 行，每行一条 prompt
    └── run.sh            # 单项目执行脚本
```

## 单项目 run.sh 必须实现

1. **克隆仓库**：`git clone --depth 1` 到 `{project-id}/workspace/{project-id}/`；已存在则 shallow fetch
2. **顺序执行 100 条任务**：读取同目录 `tasks.txt`，用 `claude -p` 逐条执行
3. **保持同一会话上下文**：第一条用 `claude -p`；后续用 `--resume $session_id`（从首条 JSON 输出解析）或 `--continue` 兜底
4. **自动批准**：`--permission-mode auto`，`--max-turns 50`（可选 `--max-budget-usd` 限制单任务费用）
5. **后台运行**：`./run.sh --background` 用 nohup 挂起，写 PID 到 `run.pid`
6. **进度查看**：`./run.sh --status` 输出 `progress.json`（current/total/percent/status/last_task/updated_at/pid）
7. **日志**：`logs/main.log` 总日志 + `logs/task_001.log` … `task_100.log` 每任务日志
8. **停止**：`./run.sh --stop` 杀 PID

## run-all.sh 必须实现

- `./run-all.sh`：顺序跑完全部项目
- `./run-all.sh --parallel N`：最多 N 个项目同时后台跑
- `./run-all.sh --status`：汇总所有项目进度
- `./run-all.sh --stop-all`：停止全部

## manifest.json 格式

```json
{
  "generated_at": "ISO8601",
  "projects": [
    {
      "id": "...",
      "name": "...",
      "repo": "...",
      "domain": "...",
      "dir": "/绝对路径/token-burn/{id}",
      "tasks": 100
    }
  ]
}
```

## 实现方式

优先维护一个 Python 生成器 `generate.py`：
- `make_prompt(project, index)` 按阶段模板生成单条任务
- `write_tasks()` 写 tasks.txt
- `write_run_sh()` 从 RUN_SH 模板生成 run.sh
- `main()` 遍历 PROJECTS 生成全部文件

运行 `python3 generate.py` 即可一键再生成。

## 本次生成要求（按需修改）

- 项目数量：10
- 替换策略：全部换新仓库 / 保留部分换部分（说明哪些保留）
- 领域偏好：（如偏基础设施、偏 AI、偏前端，或不限）
- 任务总数：每个项目 100 条
- 输出路径：`~/Documents/register-phone/token-burn/`
- 若旧目录已存在：先备份到 `token-burn/archive/YYYYMMDD-HHMM/` 再覆盖

请直接生成/更新 `generate.py` 并运行它，确认 bash 语法检查通过，最后列出 10 个仓库名和使用说明。
```

---

## 变体 Prompt 片段（按需追加）

### 只换仓库，不换模板

```
只更新 generate.py 里的 PROJECTS 数组，换 10 个新的 GitHub 中大型项目。
areas 和 topics 必须针对新项目重新编写。
然后运行 python3 generate.py 覆盖生成。
```

### 换批次目录（避免覆盖正在跑的任务）

```
本次输出到 ~/Documents/register-phone/token-burn/batch-20260627/
同步修改 generate.py 的 ROOT 路径，manifest 和 run-all.sh 也生成到该目录。
```

### 减少费用风险

```
在 run.sh 的 CLAUDE_FLAGS 中默认启用 --max-budget-usd 1，
并把 --max-turns 降到 30。
```

### 增加项目数量

```
本次生成 15 个项目，每个 80 条任务。
相应调整阶段划分比例，保持由浅入深的顺序。
```

---

## 当前批次（2026-06-27）

| id | 仓库 |
|----|------|
| kubernetes | kubernetes/kubernetes |
| golang | golang/go |
| react | facebook/react |
| nextjs | vercel/next.js |
| redis | redis/redis |
| prometheus | prometheus/prometheus |
| grpc-go | grpc/grpc-go |
| kafka | apache/kafka |
| pytorch | pytorch/pytorch |
| istio | istio/istio |

---

## 常用命令

```bash
# 再生成文件
cd ~/Documents/register-phone/token-burn && python3 generate.py

# 单项目后台
./kubernetes/run.sh --background
./kubernetes/run.sh --status
tail -f kubernetes/logs/main.log

# 全部项目
./run-all.sh --parallel 3
./run-all.sh --status
./run-all.sh --stop-all
```
