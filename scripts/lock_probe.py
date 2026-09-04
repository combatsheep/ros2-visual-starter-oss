#!/usr/bin/env python3
"""Report whether a regular lock file is currently held by another process."""

from __future__ import annotations

import fcntl
import os
import stat
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: lock_probe.py PATH")
    path = Path(sys.argv[1])
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit("lock path is not a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        raise SystemExit(1)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    main()
