#!/usr/bin/env python3
"""Apply a cross-process fcntl lock to an inherited shell file descriptor."""

from __future__ import annotations

import fcntl
import os
import stat
import sys
from pathlib import Path


BUSY = 75


def checked_fd(fd: int, path: Path) -> os.stat_result:
    descriptor = os.fstat(fd)
    pathname = os.lstat(path)
    if not stat.S_ISREG(pathname.st_mode) or (descriptor.st_dev, descriptor.st_ino) != (pathname.st_dev, pathname.st_ino):
        raise RuntimeError("lock file identity mismatch")
    return descriptor


def write_owner(fd: int, owner: str) -> None:
    os.ftruncate(fd, 0)
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, (f"{owner}\n" if owner else "").encode("ascii"))
    os.fsync(fd)


def read_owner(fd: int) -> str:
    os.lseek(fd, 0, os.SEEK_SET)
    return os.read(fd, 128).decode("ascii", errors="strict").strip()


def main() -> None:
    if len(sys.argv) != 5 or sys.argv[1] not in {"acquire", "release", "validate"}:
        raise SystemExit("usage: lock_fd.py acquire|release|validate FD PATH OWNER_PID")
    action, fd_text, path_text, owner = sys.argv[1:]
    if not fd_text.isdigit() or not owner.isdigit() or int(owner) < 1:
        raise SystemExit("invalid lock identity")
    fd = int(fd_text)
    path = Path(path_text)
    checked_fd(fd, path)

    if action == "acquire":
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(BUSY)
        write_owner(fd, owner)
        return

    if read_owner(fd) != owner:
        raise SystemExit("lock owner mismatch")
    if action == "validate":
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("lock is not inherited from its owner")
        return

    write_owner(fd, "")
    fcntl.flock(fd, fcntl.LOCK_UN)


if __name__ == "__main__":
    main()
