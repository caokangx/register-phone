#!/usr/bin/env python3
"""Build projects_catalog.json with N GitHub repos (default 1000 new + keep base 10)."""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "projects_catalog.json"

# Existing 10 projects (keep full metadata)
BASE_PROJECTS = [
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

# Category templates for auto-generated areas/topics
CATEGORY_TEMPLATES: dict[str, dict] = {
    "systems": {
        "domain": "系统软件与基础设施",
        "areas": ["src", "pkg", "internal", "cmd", "lib", "core", "api", "runtime", "tests", "docs"],
        "topics": [
            "模块边界与依赖", "配置与启动流程", "错误处理策略", "并发与锁模型",
            "I/O 与事件循环", "内存分配与池化", "序列化路径", "扩展点设计",
            "观测性埋点", "性能热点", "降级与限流", "测试覆盖边界",
        ],
    },
    "lang": {
        "domain": "编程语言与编译器",
        "areas": ["src", "compiler", "runtime", "stdlib", "cmd", "internal", "lib", "test", "tools", "docs"],
        "topics": [
            "词法语法分析", "类型系统", "IR 与优化", "代码生成", "GC 或内存管理",
            "标准库设计", "并发原语", "FFI 互操作", "包管理", "调试与 profiling",
            "向后兼容", "语言规范实现",
        ],
    },
    "frontend": {
        "domain": "前端框架与 UI",
        "areas": ["src", "packages", "components", "lib", "runtime", "compiler", "build", "tests", "docs", "examples"],
        "topics": [
            "组件模型", "状态管理", "渲染管线", "路由系统", "构建与打包",
            "SSR/CSR 边界", "性能优化", "Tree-shaking", "样式方案", "测试策略",
            "无障碍 a11y", "开发者工具",
        ],
    },
    "database": {
        "domain": "数据库与存储引擎",
        "areas": ["src", "storage", "engine", "sql", "parser", "executor", "wal", "tests", "tools", "docs"],
        "topics": [
            "存储布局", "索引结构", "事务与隔离", "WAL 与恢复", "查询优化器",
            "连接池", "复制与高可用", "分片策略", "缓存层", "压缩编码",
            "备份恢复", "监控指标",
        ],
    },
    "devops": {
        "domain": "DevOps 与可观测性",
        "areas": ["cmd", "pkg", "internal", "api", "operator", "charts", "deploy", "tests", "docs", "config"],
        "topics": [
            "部署流水线", "配置管理", "指标采集", "日志聚合", "告警规则",
            "服务发现", "健康检查", "滚动升级", "多租户", "权限模型",
            "资源配额", "灾难恢复",
        ],
    },
    "ai": {
        "domain": "人工智能与机器学习",
        "areas": ["src", "models", "training", "inference", "ops", "data", "utils", "tests", "examples", "docs"],
        "topics": [
            "模型架构", "训练循环", "推理优化", "分布式训练", "量化压缩",
            "数据流水线", "算子实现", "自动微分", "checkpoint", "GPU 利用率",
            "批处理策略", "评估指标",
        ],
    },
    "security": {
        "domain": "安全与密码学",
        "areas": ["src", "crypto", "auth", "core", "lib", "cmd", "internal", "tests", "docs", "fuzz"],
        "topics": [
            "认证授权", "加密算法", "密钥管理", "TLS 实现", "漏洞防护",
            "审计日志", "沙箱隔离", "输入校验", "侧信道防护", "证书链",
            "零信任", "合规检查",
        ],
    },
    "network": {
        "domain": "网络与通信",
        "areas": ["src", "transport", "protocol", "proxy", "core", "lib", "cmd", "internal", "tests", "docs"],
        "topics": [
            "协议栈", "连接管理", "多路复用", "负载均衡", "DNS 解析",
            "TLS 终止", "流量整形", "NAT 穿透", "拥塞控制", "零拷贝",
            "服务网格集成", "可观测性",
        ],
    },
    "mobile": {
        "domain": "移动与跨平台",
        "areas": ["lib", "src", "engine", "platform", "runtime", "widgets", "tests", "examples", "tools", "docs"],
        "topics": [
            "渲染引擎", "布局系统", "平台桥接", "热更新", "性能 profiling",
            "内存管理", "手势事件", "插件生态", "构建打包", "测试框架",
            "无障碍", "应用生命周期",
        ],
    },
    "tools": {
        "domain": "开发者工具与 CLI",
        "areas": ["src", "cmd", "pkg", "internal", "lib", "api", "plugins", "tests", "docs", "scripts"],
        "topics": [
            "CLI 设计", "插件架构", "配置解析", "增量构建", "缓存策略",
            "LSP 集成", "代码生成", "错误提示", "并行执行", "跨平台",
            "扩展 API", "发布流程",
        ],
    },
}

# Curated seed repos: (org, repo, category, optional_domain_override)
SEED_REPOS: list[tuple[str, str, str, str | None]] = []


def _slug_id(org: str, repo: str) -> str:
    raw = f"{org}-{repo}".lower()
    return re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")


def _display_name(repo: str) -> str:
    return repo.replace("-", " ").replace("_", " ").title()


def _categorize(language: str | None, topics: list[str] | None) -> str:
    lang = (language or "").lower()
    tset = {t.lower() for t in (topics or [])}
    if any(k in tset for k in ("machine-learning", "deep-learning", "pytorch", "tensorflow", "llm")):
        return "ai"
    if lang in ("javascript", "typescript") or "react" in tset or "frontend" in tset:
        return "frontend"
    if any(k in tset for k in ("database", "sql", "nosql", "storage")):
        return "database"
    if any(k in tset for k in ("security", "cryptography", "encryption")):
        return "security"
    if any(k in tset for k in ("docker", "kubernetes", "devops", "monitoring", "ci-cd")):
        return "devops"
    if lang in ("go", "rust", "c", "c++") and any(k in tset for k in ("network", "proxy", "grpc")):
        return "network"
    if lang in ("kotlin", "swift", "dart") or "mobile" in tset or "android" in tset or "ios" in tset:
        return "mobile"
    if lang in ("c", "c++", "rust", "go") and any(k in tset for k in ("compiler", "language", "runtime")):
        return "lang"
    if lang in ("python", "javascript", "typescript", "go", "rust") and any(
        k in tset for k in ("cli", "tool", "developer-tools")
    ):
        return "tools"
    if lang in ("c", "c++", "rust", "go"):
        return "systems"
    return "tools"


def _make_project(org: str, repo: str, category: str, domain_override: str | None = None) -> dict:
    tpl = CATEGORY_TEMPLATES.get(category, CATEGORY_TEMPLATES["systems"])
    pid = _slug_id(org, repo)
    name = _display_name(repo)
    domain = domain_override or tpl["domain"]
    areas = [a.replace("{name}", repo) for a in tpl["areas"]]
    topics = [t.replace("{name}", name) for t in tpl["topics"]]
    return {
        "id": pid,
        "name": name,
        "repo": f"https://github.com/{org}/{repo}.git",
        "domain": domain,
        "areas": areas,
        "topics": topics,
        "category": category,
    }


def _github_fetch(query: str, per_page: int = 100, pages: int = 10) -> list[dict]:
    results: list[dict] = []
    for page in range(1, pages + 1):
        params = urllib.parse.urlencode(
            {"q": query, "sort": "stars", "order": "desc", "per_page": per_page, "page": page}
        )
        url = f"https://api.github.com/search/repositories?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            print(f"GitHub API error page {page}: {e}", file=sys.stderr)
            break
        items = data.get("items", [])
        if not items:
            break
        results.extend(items)
        print(f"  fetched page {page}: {len(items)} repos")
    return results


def _embedded_seed_repos() -> list[tuple[str, str, str, str | None]]:
    """Fallback curated list when API is rate-limited."""
    from catalog_seeds import SEED_REPOS as seeds  # noqa: PLC0415
    return seeds


def collect_new_repos(target: int, exclude_ids: set[str]) -> list[dict]:
    queries = [
        "stars:>20000",
        "stars:>10000 language:Go",
        "stars:>10000 language:Rust",
        "stars:>10000 language:Python",
        "stars:>10000 language:JavaScript",
        "stars:>10000 language:TypeScript",
        "stars:>8000 language:Java",
        "stars:>8000 language:C++",
        "stars:>5000 topic:kubernetes",
        "stars:>5000 topic:database",
        "stars:>5000 topic:machine-learning",
        "stars:>5000 topic:blockchain",
        "stars:>5000 topic:game",
    ]
    seen: set[str] = set(exclude_ids)
    projects: list[dict] = []

    print("Fetching from GitHub API...")
    for q in queries:
        if len(projects) >= target:
            break
        print(f"Query: {q}")
        for item in _github_fetch(q, per_page=100, pages=5):
            full = item.get("full_name", "")
            if "/" not in full:
                continue
            org, repo = full.split("/", 1)
            pid = _slug_id(org, repo)
            if pid in seen or item.get("fork"):
                continue
            if item.get("archived"):
                continue
            cat = _categorize(item.get("language"), item.get("topics"))
            projects.append(_make_project(org, repo, cat))
            seen.add(pid)
            if len(projects) >= target:
                break

    if len(projects) < target:
        print(f"API gave {len(projects)}, filling from embedded seeds...")
        for org, repo, cat, dom in _embedded_seed_repos():
            if len(projects) >= target:
                break
            pid = _slug_id(org, repo)
            if pid in seen:
                continue
            projects.append(_make_project(org, repo, cat, dom))
            seen.add(pid)

    return projects[:target]


def build_catalog(new_count: int = 1000) -> list[dict]:
    base_ids = {p["id"] for p in BASE_PROJECTS}
    new_projects = collect_new_repos(new_count, base_ids)
    all_projects = list(BASE_PROJECTS) + new_projects
    # dedupe by id preserving order
    seen: set[str] = set()
    deduped: list[dict] = []
    for p in all_projects:
        if p["id"] in seen:
            continue
        seen.add(p["id"])
        deduped.append(p)
    return deduped


def main() -> None:
    new_count = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    projects = build_catalog(new_count)
    payload = {
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "base_count": len(BASE_PROJECTS),
        "new_count": len(projects) - len(BASE_PROJECTS),
        "total": len(projects),
        "projects": projects,
    }
    CATALOG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {CATALOG_PATH}")
    print(f"Total: {payload['total']} (base {payload['base_count']} + new {payload['new_count']})")


if __name__ == "__main__":
    main()
