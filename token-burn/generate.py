#!/usr/bin/env python3
"""Generate project runners with progressive Claude Code prompts.

Regenerate:
  python3 generate.py

Full spec and copy-paste AI prompt:
  See REGENERATE_PROMPT.md in this directory.
"""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent  # Documents/register-phone/token-burn

PROJECTS = [
    {
        "id": "kubernetes",
        "name": "Kubernetes",
        "repo": "https://github.com/kubernetes/kubernetes.git",
        "domain": "容器编排与分布式系统",
        "areas": [
            "pkg/apiserver", "pkg/kubelet", "pkg/scheduler", "pkg/controller",
            "staging/src/k8s.io/client-go", "cmd/kube-apiserver", "pkg/registry",
            "pkg/proxy", "pkg/volume", "test/integration",
        ],
        "topics": [
            "API Server 请求链路", "Informer 缓存机制", "Scheduler 打分插件",
            "Controller Reconcile 循环", "etcd 读写路径", "准入控制器",
            "CRI 容器运行时接口", "CNI 网络插件集成", "RBAC 鉴权",
            "Watch 机制与资源版本", "Lease 选主", "HPA 扩缩容",
        ],
    },
    {
        "id": "golang",
        "name": "Go",
        "repo": "https://github.com/golang/go.git",
        "domain": "编程语言编译器与运行时",
        "areas": [
            "src/cmd/compile", "src/runtime", "src/cmd/go", "src/net/http",
            "src/sync", "src/reflect", "src/go/types", "src/cmd/link",
            "src/internal/gc", "test",
        ],
        "topics": [
            "SSA 中间表示", "逃逸分析", "GC 三色标记", "调度器 GMP 模型",
            "内联优化", "逃逸到堆", "channel 实现", "defer 机制",
            "map 扩容", "interface 动态派发", "pprof 采样", "race detector",
        ],
    },
    {
        "id": "react",
        "name": "React",
        "repo": "https://github.com/facebook/react.git",
        "domain": "前端 UI 库与并发渲染",
        "areas": [
            "packages/react-reconciler", "packages/react-dom", "packages/scheduler",
            "packages/react", "packages/react-server", "packages/shared",
            "packages/react-devtools-shared", "compiler",
        ],
        "topics": [
            "Fiber 架构", "双缓冲树", "Lane 优先级", "Scheduler 时间切片",
            "Hooks 链表", "Suspense 边界", "Concurrent Mode", "事件委托",
            "Hydration", "Server Components", "Compiler 自动 memo", "批处理更新",
        ],
    },
    {
        "id": "nextjs",
        "name": "Next.js",
        "repo": "https://github.com/vercel/next.js.git",
        "domain": "全栈 React 框架",
        "areas": [
            "packages/next", "packages/next/src/server", "packages/next/src/build",
            "packages/next/src/client", "packages/next/src/shared/lib",
            "packages/next/src/export", "turbopack", "packages/next/src/server/app-render",
        ],
        "topics": [
            "App Router", "RSC 流式渲染", "中间件链", "ISR 增量静态再生",
            "Turbopack 打包", "路由缓存", "Server Actions", "Edge Runtime",
            "图片优化", "字体优化", "Prefetch 策略", "构建缓存",
        ],
    },
    {
        "id": "redis",
        "name": "Redis",
        "repo": "https://github.com/redis/redis.git",
        "domain": "内存数据库与持久化",
        "areas": [
            "src", "src/commands", "src/networking.c", "src/rdb.c", "src/aof.c",
            "src/evict.c", "src/cluster.c", "src/replication.c", "src/modules",
        ],
        "topics": [
            "事件循环 epoll", "SDS 字符串", "跳表 zset", "渐进式 rehash",
            "LRU/LFU 淘汰", "RDB 快照", "AOF 重写", "主从复制",
            "Sentinel 故障转移", "Cluster 槽迁移", "内存碎片", "Lua 脚本原子性",
        ],
    },
    {
        "id": "prometheus",
        "name": "Prometheus",
        "repo": "https://github.com/prometheus/prometheus.git",
        "domain": "云原生监控与时序数据库",
        "areas": [
            "tsdb", "scrape", "promql", "discovery", "storage/remote",
            "cmd/prometheus", "model", "rules", "web", "util",
        ],
        "topics": [
            "TSDB 块存储", "WAL 预写日志", "Head 压缩", "PromQL 引擎",
            "服务发现", "抓取间隔", "远程读写", "告警规则评估",
            "标签基数爆炸", "Histogram 直方图", "Exemplar 关联", "联邦集群",
        ],
    },
    {
        "id": "grpc-go",
        "name": "gRPC-Go",
        "repo": "https://github.com/grpc/grpc-go.git",
        "domain": "高性能 RPC 框架",
        "areas": [
            "balancer", "credentials", "encoding", "internal/transport",
            "resolver", "stats", "stream", "keepalive", "metadata",
        ],
        "topics": [
            "HTTP/2 多路复用", "连接池", "负载均衡 pick_first/round_robin",
            "拦截器链", "流控窗口", "TLS 握手", "Resolver 服务发现",
            "压缩算法", "Keepalive 探活", "错误码映射", "背压处理", "零拷贝",
        ],
    },
    {
        "id": "kafka",
        "name": "Apache Kafka",
        "repo": "https://github.com/apache/kafka.git",
        "domain": "分布式流处理平台",
        "areas": [
            "core/src/main/scala/kafka", "clients/src/main/java/org/apache/kafka",
            "connect", "streams", "raft", "storage", "metadata",
        ],
        "topics": [
            "分区 Leader 选举", "ISR 同步副本", "零拷贝 sendfile",
            "日志段滚动", "消费者组 Rebalance", "事务消息",
            "KRaft 元数据", "压缩 batch", "幂等生产者", "水位 HW/LEO",
            "Connect 框架", "Streams 状态存储",
        ],
    },
    {
        "id": "pytorch",
        "name": "PyTorch",
        "repo": "https://github.com/pytorch/pytorch.git",
        "domain": "深度学习框架",
        "areas": [
            "torch/csrc", "aten/src/ATen", "c10", "torch/nn", "torch/autograd",
            "torch/distributed", "torch/fx", "torch/_inductor", "test",
        ],
        "topics": [
            "Autograd 反向传播", "Dispatcher 算子分发", "CUDA kernel 融合",
            "DDP 分布式训练", "TorchScript 编译", "Inductor 代码生成",
            "内存池分配", "算子融合", "动态图 vs 静态图", "Profiler 火焰图",
            "量化 INT8", "Checkpoint 梯度检查点",
        ],
    },
    {
        "id": "istio",
        "name": "Istio",
        "repo": "https://github.com/istio/istio.git",
        "domain": "服务网格与流量治理",
        "areas": [
            "pilot/pkg", "istioctl", "pkg/config", "security/pkg",
            "pilot/pkg/model", "pilot/pkg/xds", "pkg/kube", "operator",
        ],
        "topics": [
            "xDS 配置下发", "Envoy sidecar 注入", "VirtualService 路由",
            "mTLS 双向认证", "流量镜像", "熔断限流", "Waypoint 代理",
            "多集群联邦", "Wasm 扩展", "Telemetry 追踪", "证书轮换", "Gateway API",
        ],
    },
]


def phase_for_index(i: int) -> str:
    if i <= 15:
        return "analyze"
    if i <= 30:
        return "deep_dive"
    if i <= 45:
        return "perf_scan"
    if i <= 60:
        return "bottleneck"
    if i <= 75:
        return "optimize_plan"
    if i <= 90:
        return "optimize_exec"
    return "verify"


def make_prompt(project: dict, index: int) -> str:
    """Build one progressive prompt (1-based index)."""
    p = project
    phase = phase_for_index(index)
    area = p["areas"][(index - 1) % len(p["areas"])]
    topic = p["topics"][(index - 1) % len(p["topics"])]
    n = index

    templates = {
        "analyze": [
            f"【任务 {n}/100 · 架构分析】阅读 {area} 目录的入口文件和 README，绘制 {p['name']} 在 {p['domain']} 中的模块边界图（用文字描述即可）。列出该目录下前 20 个关键源文件及其职责，并说明它们与 {topic} 的关联。",
            f"【任务 {n}/100 · 依赖梳理】在 {area} 中搜索 import/include 关系，找出被最多文件引用的 10 个核心模块。解释每个模块在 {topic} 场景中的作用，并估算代码行数规模。",
            f"【任务 {n}/100 · 调用链追踪】从 {area} 的 public API 出发，追踪一条典型请求/调用链直到底层实现。逐步列出经过的函数/类，并标注与 {topic} 相关的节点。",
            f"【任务 {n}/100 · 配置审计】搜索项目中与 {topic} 相关的配置项、环境变量、feature flag。整理成表格：名称、默认值、影响范围、所在文件路径。",
            f"【任务 {n}/100 · 测试覆盖】在 test 目录中找到覆盖 {area} 或 {topic} 的测试文件，阅读至少 3 个测试用例，总结被测试的行为边界和已知限制。",
        ],
        "deep_dive": [
            f"【任务 {n}/100 · 源码精读】深入阅读 {area} 中与 {topic} 最相关的 3-5 个源文件。逐段解释核心数据结构和算法，指出设计权衡（trade-off）。",
            f"【任务 {n}/100 · 并发模型】分析 {area} 中的锁、goroutine/thread、channel、原子操作或等效并发原语。画出并发交互图，标出可能的竞态窗口。",
            f"【任务 {n}/100 · 错误处理】统计 {area} 中的错误返回/异常处理模式。分类列举：可恢复错误、致命错误、重试逻辑，各举 2 个代码示例（引用文件和行号）。",
            f"【任务 {n}/100 · 内存与生命周期】追踪 {topic} 相关对象从创建到销毁的完整生命周期。标注堆/栈分配、池化、缓存、泄漏风险点。",
            f"【任务 {n}/100 · 扩展点】找出 {area} 中的 plugin/hook/interface 扩展机制。说明第三方如何接入 {topic}，并评估扩展 API 的稳定性。",
        ],
        "perf_scan": [
            f"【任务 {n}/100 · 性能热点扫描】在 {area} 中搜索循环嵌套、递归、全表扫描、O(n²) 算法、频繁分配等性能敏感模式。列出 top 10 可疑位置及理由。",
            f"【任务 {n}/100 · I/O 路径】分析 {topic} 的 I/O 路径（磁盘/网络/序列化）。估算每次操作的系统调用次数和数据拷贝次数，指出可优化的环节。",
            f"【任务 {n}/100 · 缓存策略】审查 {area} 中所有 cache/memoize/buffer 实现。对比命中率优化空间、过期策略、内存上限，给出量化改进假设。",
            f"【任务 {n}/100 · 批处理机会】检查 {topic} 相关代码是否存在可合并的逐条处理。设计一个批处理方案，估算理论吞吐提升百分比。",
            f"【任务 {n}/100 · 基准测试】查找或设计针对 {area} 的 benchmark。若无现成基准，提出 3 个 micro-benchmark 场景及测量指标（延迟 P99、QPS、内存）。",
        ],
        "bottleneck": [
            f"【任务 {n}/100 · 瓶颈假设】基于前序分析，列出 {topic} 的 5 个最可能瓶颈，按影响排序。每个瓶颈需包含：证据（代码位置）、影响面、修复难度（低/中/高）。",
            f"【任务 {n}/100 · 火焰图假想】假设对 {area} 做了 CPU profiling，根据代码结构推测火焰图 top 5 函数。说明如何通过代码验证这些假设。",
            f"【任务 {n}/100 · 锁竞争】分析 {area} 中的 mutex/RWMutex/细粒度锁。识别锁粒度过粗的位置，提出 2 种减锁方案并比较。",
            f"【任务 {n}/100 · 内存分配】统计 {topic} 路径上的频繁小对象分配。建议使用 sync.Pool/arena/对象池等优化手段，并评估 GC 压力降幅。",
            f"【任务 {n}/100 · 网络往返】若 {topic} 涉及 RPC/HTTP，分析每次操作的往返次数。设计合并请求或减少 round-trip 的方案。",
        ],
        "optimize_plan": [
            f"【任务 {n}/100 · 优化方案 A】针对 {topic} 瓶颈 #1，写出详细优化方案：目标指标、改动文件列表、伪代码、风险评估、回滚策略。",
            f"【任务 {n}/100 · 优化方案 B】针对 {area} 中的序列化/反序列化路径，设计零拷贝或增量解析优化，给出 before/after 伪代码对比。",
            f"【任务 {n}/100 · 优化方案 C】为 {topic} 设计异步化/流水线改造：哪些步骤可并行、需要哪些队列/背压机制、预期延迟变化。",
            f"【任务 {n}/100 · 优化方案 D】提出算法层面优化：是否有更高效数据结构可替换当前实现？对比时间/空间复杂度并引用具体代码位置。",
            f"【任务 {n}/100 · 优化优先级】将目前识别的所有优化项放入 ICE 矩阵（Impact/Confidence/Effort），排出 top 5 实施顺序并说明理由。",
        ],
        "optimize_exec": [
            f"【任务 {n}/100 · 代码审查】在 {area} 中定位 {topic} 相关函数，逐行审查并标注可优化行。对每个标注给出具体改写建议（不需要真正提交代码）。",
            f"【任务 {n}/100 · 重构草案】为 {area} 写一个重构草案：提取哪些函数、如何拆分文件、接口如何保持向后兼容。输出建议的文件树结构。",
            f"【任务 {n}/100 · 配置调优】列出 {topic} 相关的所有可调参数，给出生产环境推荐值及调优步骤（先测什么指标、再调什么参数）。",
            f"【任务 {n}/100 · 降级策略】为 {topic} 设计过载保护：限流阈值、熔断条件、降级行为。引用项目中已有的类似实现作为参考。",
            f"【任务 {n}/100 · 观测增强】设计针对 {area} 的 metrics/tracing/logging 增强方案：新增哪些指标、在哪些函数埋点、告警规则建议。",
        ],
        "verify": [
            f"【任务 {n}/100 · 回归测试计划】为 {topic} 相关优化编写测试计划：单元测试、集成测试、压力测试各需要覆盖哪些场景。",
            f"【任务 {n}/100 · 性能对比】设计 A/B 对比实验：baseline vs optimized 的测量方法、样本量、显著性判断标准。",
            f"【任务 {n}/100 · 文档更新】起草 {area} 的性能优化文档章节：背景、改动摘要、基准数据占位符、运维注意事项。",
            f"【任务 {n}/100 · 技术债清单】汇总 {p['name']} 在 {topic} 方面的技术债，分短期（1周）、中期（1月）、长期（1季）三档。",
            f"【任务 {n}/100 · 最终报告】综合前 99 项分析，输出 {p['name']} {topic} 优化全景报告：执行摘要、关键发现、推荐行动项、未解问题。",
        ],
    }

    pool = templates[phase]
    return pool[(index - 1) % len(pool)]


def write_tasks(project: dict, out_dir: Path) -> None:
    lines = [make_prompt(project, i) for i in range(1, 101)]
    (out_dir / "tasks.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


RUN_SH = r'''#!/usr/bin/env bash
# Auto-generated runner for {name}
# Usage:
#   ./run.sh              # foreground
#   ./run.sh --background # background with progress tracking
#   ./run.sh --status     # show progress
#   ./run.sh --stop       # stop background run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_BURN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$TOKEN_BURN_DIR/env.sh" ]] && source "$TOKEN_BURN_DIR/env.sh"
PROJECT_ID="{id}"
REPO_URL="{repo}"
PROJECT_NAME="{id}"
WORK_DIR="${{WORK_DIR:-$SCRIPT_DIR/workspace}}"
CLONE_DIR="$WORK_DIR/$PROJECT_NAME"
LOG_DIR="$SCRIPT_DIR/logs"
PROGRESS_FILE="$SCRIPT_DIR/progress.json"
PID_FILE="$SCRIPT_DIR/run.pid"
TASKS_FILE="$SCRIPT_DIR/tasks.txt"
MAIN_LOG="$LOG_DIR/main.log"

CLAUDE_BIN="${{CLAUDE_BIN:-claude}}"
CLAUDE_FLAGS=(
  --permission-mode auto
  --max-turns 50
)
# Uncomment to cap cost per task:
# CLAUDE_FLAGS+=(--max-budget-usd 2)

mkdir -p "$LOG_DIR" "$WORK_DIR"

write_progress() {{
  local current="$1" total="$2" status="$3" last_task="$4"
  python3 - "$PROGRESS_FILE" "$PROJECT_ID" "$current" "$total" "$status" "$last_task" "$LOG_DIR" "$CLONE_DIR" "$PID_FILE" <<'PY'
import json, sys
from datetime import datetime, timezone
out, project, current, total, status, last_task, log_dir, clone_dir, pid_file = sys.argv[1:10]
try:
    pid = int(open(pid_file).read().strip())
except Exception:
    pid = None
data = {
    "project": project,
    "current": int(current),
    "total": int(total),
    "percent": round(100 * int(current) / max(int(total), 1), 1),
    "status": status,
    "last_task": last_task,
    "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "pid": pid,
    "log_dir": log_dir,
    "clone_dir": clone_dir,
}
open(out, "w").write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}}

show_status() {{
  if [[ -f "$PROGRESS_FILE" ]]; then
    python3 - "$PROGRESS_FILE" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path, encoding="utf-8"))
print(f"Project: {{d['project']}} | Task {{d['current']}}/{{d['total']}} ({{d['percent']}}%) | {{d['status']}}")
if d.get("last_task"):
    print(d["last_task"])
print()
print(json.dumps(d, ensure_ascii=False, indent=2))
PY
  else
    echo "No progress yet. Run ./run.sh first."
  fi
  echo ""
  echo "Tail main log: tail -f $MAIN_LOG"
  echo "Tail latest task: ls -t $LOG_DIR/task_*.log 2>/dev/null | head -1 | xargs tail -f"
}}

stop_run() {{
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "Stopped PID $pid"
    else
      echo "Process $pid not running"
    fi
    rm -f "$PID_FILE"
  else
    echo "No PID file"
  fi
}}

clone_repo() {{
  if [[ -d "$CLONE_DIR/.git" ]]; then
    echo "[$(date)] Repo exists, fetching latest (shallow)..." | tee -a "$MAIN_LOG"
    git -C "$CLONE_DIR" fetch --depth 1 origin 2>&1 | tee -a "$MAIN_LOG" || true
    git -C "$CLONE_DIR" checkout -f HEAD 2>&1 | tee -a "$MAIN_LOG" || true
  else
    echo "[$(date)] Cloning $REPO_URL ..." | tee -a "$MAIN_LOG"
    git clone --depth 1 "$REPO_URL" "$CLONE_DIR" 2>&1 | tee -a "$MAIN_LOG"
  fi
}}

run_tasks() {{
  cd "$CLONE_DIR"
  local total=100
  local current=0
  local first=true
  local session_id=""

  write_progress 0 "$total" "running" ""

  while IFS= read -r prompt || [[ -n "$prompt" ]]; do
    [[ -z "$prompt" ]] && continue
    current=$((current + 1))
    local task_log="$LOG_DIR/task_$(printf '%03d' "$current").log"

    echo "" | tee -a "$MAIN_LOG"
    echo "========== [$PROJECT_ID] Task $current/$total ==========" | tee -a "$MAIN_LOG"
    echo "$prompt" | tee -a "$MAIN_LOG"
    write_progress "$current" "$total" "running" "$prompt"

    set +e
    if $first; then
      "$CLAUDE_BIN" -p "$prompt" "${{CLAUDE_FLAGS[@]}}" --output-format json 2>&1 | tee "$task_log" || true
      session_id=$(python3 -c "import json,sys; d=json.load(open('$task_log')); print(d.get('session_id',''))" 2>/dev/null || echo "")
      first=false
    else
      if [[ -n "$session_id" ]]; then
        "$CLAUDE_BIN" -p "$prompt" --resume "$session_id" "${{CLAUDE_FLAGS[@]}}" --output-format json 2>&1 | tee "$task_log" || true
      else
        "$CLAUDE_BIN" -p "$prompt" --continue "${{CLAUDE_FLAGS[@]}}" --output-format json 2>&1 | tee "$task_log" || true
      fi
    fi
    set -e

    echo "[$(date)] Task $current/$total done" | tee -a "$MAIN_LOG"
  done < "$TASKS_FILE"

  write_progress "$total" "$total" "completed" "All 100 tasks finished"
  rm -f "$PID_FILE"
  echo "[$(date)] All tasks completed for $PROJECT_ID" | tee -a "$MAIN_LOG"
}}

case "${{1:-}}" in
  --background|-b)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Already running PID $(cat "$PID_FILE")"
      exit 1
    fi
    nohup "$0" --foreground >> "$MAIN_LOG" 2>&1 &
    echo $! > "$PID_FILE"
    write_progress 0 100 "starting" "Background launch"
    echo "Started $PROJECT_ID in background, PID=$(cat "$PID_FILE")"
    echo "Progress: $0 --status"
    echo "Logs:     tail -f $MAIN_LOG"
    ;;
  --status|-s)
    show_status
    ;;
  --stop)
    stop_run
    ;;
  --foreground|-f|"")
    clone_repo
    run_tasks
    ;;
  *)
    echo "Usage: $0 [--background|--status|--stop|--foreground]"
    exit 1
    ;;
esac
'''


def write_run_sh(project: dict, out_dir: Path) -> None:
    content = (
        RUN_SH.replace("{id}", project["id"])
        .replace("{name}", project["name"])
        .replace("{repo}", project["repo"])
        .replace("{{", "{")
        .replace("}}", "}")
    )
    path = out_dir / "run.sh"
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def write_manifest(projects: list[dict], root: Path) -> None:
  manifest = {
      "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
      "projects": [
          {
              "id": p["id"],
              "name": p["name"],
              "repo": p["repo"],
              "domain": p["domain"],
              "dir": str(root / p["id"]),
              "tasks": 100,
          }
          for p in projects
      ],
  }
  (root / "manifest.json").write_text(
      json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
  )


MASTER_RUN_ALL = r'''#!/usr/bin/env bash
# Run all 10 projects sequentially or in parallel
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 [--background] [--parallel N] [--status] [--stop-all]"
  echo "  --background   Start each project runner in background"
  echo "  --parallel N   Start up to N projects concurrently (default 1 = sequential)"
  echo "  --status       Show progress for all projects"
  echo "  --stop-all     Stop all background runners"
}

show_all_status() {
  for dir in "$SCRIPT_DIR"/*/; do
  [[ -f "$dir/run.sh" ]] || continue
  name=$(basename "$dir")
  echo "===== $name ====="
  "$dir/run.sh" --status 2>/dev/null || echo "(not started)"
  echo ""
  done
}

stop_all() {
  for dir in "$SCRIPT_DIR"/*/; do
  [[ -f "$dir/run.sh" ]] || continue
  "$dir/run.sh" --stop 2>/dev/null || true
  done
  echo "All stop signals sent."
}

run_projects() {
  local mode="${1:-foreground}"
  local parallel="${2:-1}"
  local projects=()
  for dir in "$SCRIPT_DIR"/*/; do
    [[ -f "$dir/run.sh" ]] || continue
    projects+=("$dir")
  done

  if [[ "$parallel" -le 1 ]]; then
    for dir in "${projects[@]}"; do
      echo ">>> Starting $(basename "$dir")"
      if [[ "$mode" == "background" ]]; then
        "$dir/run.sh" --background
      else
        "$dir/run.sh" --foreground
      fi
    done
  else
    local running=0
    for dir in "${projects[@]}"; do
      echo ">>> Launching $(basename "$dir")"
      "$dir/run.sh" --background
      running=$((running + 1))
      if [[ $running -ge $parallel ]]; then
        wait -n 2>/dev/null || sleep 30
        running=$((running - 1))
      fi
    done
    wait || true
  fi
}

case "${1:-}" in
  --background|-b)
    run_projects background "${2:-1}"
    ;;
  --parallel|-p)
    run_projects background "${2:-3}"
    ;;
  --status|-s)
    show_all_status
    ;;
  --stop-all)
    stop_all
    ;;
  --help|-h)
    usage
    ;;
  "")
    run_projects foreground 1
    ;;
  *)
    usage
    exit 1
    ;;
esac
'''


def main() -> None:
    root = ROOT
    root.mkdir(parents=True, exist_ok=True)

    for project in PROJECTS:
        out_dir = root / project["id"]
        out_dir.mkdir(parents=True, exist_ok=True)
        write_tasks(project, out_dir)
        write_run_sh(project, out_dir)
        print(f"Generated {out_dir}")

    write_manifest(PROJECTS, root)

    master = root / "run-all.sh"
    master.write_text(MASTER_RUN_ALL, encoding="utf-8")
    master.chmod(0o755)

  # README for user - actually user rule says don't create markdown unless asked
  # Skip README

    print(f"\nDone. {len(PROJECTS)} projects × 100 tasks = {len(PROJECTS)*100} prompts")
    print(f"Location: {root}")


if __name__ == "__main__":
    main()
