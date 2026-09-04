#!/usr/bin/env python3
"""Keep an OS-visible generation marker inside one managed process group."""

from __future__ import annotations

import re
import signal
import sys


SERVICES = {"frontend", "optional_llm", "ros_backend"}


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in SERVICES or not re.fullmatch(r"[0-9a-f]{32}", sys.argv[2]):
        raise SystemExit("usage: process_group_sentinel.py SERVICE GENERATION_TOKEN")

    def stop(_signum: int, _frame: object) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while True:
        signal.pause()


if __name__ == "__main__":
    main()
