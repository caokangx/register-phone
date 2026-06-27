#!/usr/bin/env python3
"""Pretty-print JSON files with UTF-8 characters (no \\u escapes)."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: pretty-json.py <file.json> [file2.json ...]", file=sys.stderr)
        sys.exit(1)
    for arg in sys.argv[1:]:
        path = Path(arg)
        if len(sys.argv) > 2:
            print(f"===== {path} =====")
        data = json.loads(path.read_text(encoding="utf-8"))
        print(json.dumps(data, ensure_ascii=False, indent=2))
        if len(sys.argv) > 2:
            print()


if __name__ == "__main__":
    main()
