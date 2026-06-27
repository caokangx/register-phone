#!/usr/bin/env python3
"""Aggregate Claude Code token/cost usage from task_*.log files."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def is_result(obj: object) -> bool:
    if not isinstance(obj, dict):
        return False
    return obj.get("type") == "result" or "total_cost_usd" in obj or "usage" in obj


def extract_result(path: Path) -> dict | None:
    text = path.read_text(encoding="utf-8", errors="replace")
    candidates: list[dict] = []

    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
            if is_result(obj):
                candidates.append(obj)
        except json.JSONDecodeError:
            pass

    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if is_result(obj):
            candidates.append(obj)

    return candidates[-1] if candidates else None


def usage_numbers(result: dict) -> dict:
    usage = result.get("usage") or {}
    cost = float(result.get("total_cost_usd") or 0.0)
    return {
        "cost_usd": cost,
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cache_read_input_tokens": int(usage.get("cache_read_input_tokens") or 0),
        "cache_creation_input_tokens": int(usage.get("cache_creation_input_tokens") or 0),
        "num_turns": int(result.get("num_turns") or 0),
        "duration_ms": int(result.get("duration_ms") or 0),
        "model": _primary_model(result),
    }


def _primary_model(result: dict) -> str:
    model_usage = result.get("modelUsage") or {}
    if model_usage:
        return next(iter(model_usage.keys()), "unknown")
    return "unknown"


def scan_project(project_dir: Path) -> dict:
    log_dir = project_dir / "logs"
    tasks: list[dict] = []
    if not log_dir.is_dir():
        return {
            "project": project_dir.name,
            "tasks_parsed": 0,
            "progress_current": None,
            "progress_total": None,
            "tasks": tasks,
            "totals": _empty_totals(),
        }

    for log_file in sorted(log_dir.glob("task_*.log")):
        result = extract_result(log_file)
        if not result:
            continue
        nums = usage_numbers(result)
        nums["task"] = log_file.stem
        tasks.append(nums)

    totals = _sum_tasks(tasks)
    progress_file = project_dir / "progress.json"
    progress_current = None
    progress_total = None
    if progress_file.exists():
        try:
            progress = json.loads(progress_file.read_text(encoding="utf-8"))
            progress_current = progress.get("current")
            progress_total = progress.get("total")
        except (json.JSONDecodeError, OSError):
            pass

    return {
        "project": project_dir.name,
        "tasks_parsed": len(tasks),
        "progress_current": progress_current,
        "progress_total": progress_total,
        "tasks": tasks,
        "totals": totals,
    }


def _empty_totals() -> dict:
    return {
        "cost_usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "num_turns": 0,
        "duration_ms": 0,
    }


def _sum_tasks(tasks: list[dict]) -> dict:
    totals = _empty_totals()
    for t in tasks:
        for key in totals:
            totals[key] += t.get(key, 0)
    return totals


def scan_root(root: Path, only_project: str | None = None) -> dict:
    projects: list[dict] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or not (child / "run.sh").is_file():
            continue
        if only_project and child.name != only_project:
            continue
        projects.append(scan_project(child))

    grand = _empty_totals()
    total_tasks = 0
    for p in projects:
        total_tasks += p["tasks_parsed"]
        for key in grand:
            grand[key] += p["totals"][key]

    return {
        "projects": projects,
        "grand_totals": grand,
        "tasks_parsed": total_tasks,
    }


def format_human(report: dict) -> str:
    g = report["grand_totals"]
    lines = [
        f"Tasks with usage data: {report['tasks_parsed']}",
        f"Total cost:            ${g['cost_usd']:.4f} USD",
        f"Input tokens:          {g['input_tokens']:,}",
        f"Output tokens:         {g['output_tokens']:,}",
        f"Cache read tokens:     {g['cache_read_input_tokens']:,}",
        f"Cache creation tokens: {g['cache_creation_input_tokens']:,}",
        f"Total turns:           {g['num_turns']:,}",
        f"Total duration:        {g['duration_ms'] / 1000:.1f}s",
    ]

    active = [p for p in report["projects"] if p["tasks_parsed"] > 0]
    if active:
        lines.append("")
        lines.append("Per project:")
        for p in active:
            t = p["totals"]
            prog = ""
            if p["progress_current"] is not None and p["progress_total"] is not None:
                prog = f"  progress={p['progress_current']}/{p['progress_total']}"
            lines.append(
                f"  {p['project']:<12} tasks={p['tasks_parsed']:<3} "
                f"cost=${t['cost_usd']:.4f}  "
                f"in={t['input_tokens']:,}  out={t['output_tokens']:,}  "
                f"cache_r={t['cache_read_input_tokens']:,}  "
                f"cache_c={t['cache_creation_input_tokens']:,}{prog}"
            )

        lines.append("")
        lines.append("Recent tasks (last project with logs):")
        last = active[-1]
        for task in last["tasks"][-5:]:
            lines.append(
                f"  {last['project']}/{task['task']}  "
                f"${task['cost_usd']:.4f}  "
                f"in={task['input_tokens']:,}  out={task['output_tokens']:,}  "
                f"turns={task['num_turns']}  model={task['model']}"
            )
    else:
        lines.append("")
        lines.append("(No task_*.log with Claude JSON result yet.)")

    return "\n".join(lines)


def main() -> None:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else Path(__file__).resolve().parent
    only_project = None
    as_json = False
    args = [a for a in sys.argv[1:] if not a.startswith("-") or a == "-"]
    flags = [a for a in sys.argv[1:] if a.startswith("-")]

    if "--json" in flags:
        as_json = True
    if "--project" in flags:
        idx = sys.argv.index("--project")
        only_project = sys.argv[idx + 1]

    report = scan_root(root, only_project)
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(format_human(report))


if __name__ == "__main__":
    main()
