"""Exercise the bootstrap deadline independently of the machine's activation speed."""

import importlib.util
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest


SPEC = importlib.util.spec_from_file_location(
    "wait_service_session", Path(__file__).resolve().parents[2] / "scripts/wait_service_session.py"
)
assert SPEC and SPEC.loader
waiter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(waiter)
TOKEN = "a" * 32
PID = 12345


def prepare(monkeypatch, tmp_path, *, ready_at=3.0, dead_at=None, token=TOKEN, pgid=PID):
    clock = SimpleNamespace(now=0.0, polls=0)
    monkeypatch.setattr(waiter.time, "monotonic", lambda: clock.now)
    monkeypatch.setattr(waiter.time, "sleep", lambda delay: setattr(clock, "now", clock.now + delay))
    monkeypatch.setattr(waiter.os, "getpgid", lambda pid: pgid)

    def running(pid, timeout):
        assert pid == PID
        assert 0 < timeout <= 0.5
        clock.polls += 1
        return dead_at is None or clock.now < dead_at

    def record(logs, service, suffix):
        assert logs == tmp_path
        assert service in {"frontend", "optional_llm"}
        if suffix == "token":
            return token
        if suffix == "session_ready" and clock.now < ready_at:
            return ""
        return str(PID)

    monkeypatch.setattr(waiter, "process_is_running", running)
    monkeypatch.setattr(waiter, "read_record", record)
    return clock


@pytest.mark.parametrize("service", ["frontend", "optional_llm"])
def test_live_bootstrap_can_publish_ready_after_three_seconds(monkeypatch, tmp_path, service):
    clock = prepare(monkeypatch, tmp_path)
    waiter.wait_for_session(tmp_path, service, PID, TOKEN)
    assert 3 <= clock.now < 3.1


def test_exited_bootstrap_fails_before_deadline(monkeypatch, tmp_path):
    clock = prepare(monkeypatch, tmp_path, dead_at=0.1)
    with pytest.raises(RuntimeError, match="bootstrap processが終了"):
        waiter.wait_for_session(tmp_path, "frontend", PID, TOKEN)
    assert clock.now < 0.2


def test_live_bootstrap_without_ready_has_a_ten_second_deadline(monkeypatch, tmp_path):
    clock = prepare(monkeypatch, tmp_path, ready_at=30)
    with pytest.raises(TimeoutError, match="10秒以内"):
        waiter.wait_for_session(tmp_path, "frontend", PID, TOKEN)
    assert clock.now == pytest.approx(10)


@pytest.mark.parametrize("changes", [{"token": "b" * 32}, {"pgid": PID + 1}])
def test_wrong_generation_or_session_never_becomes_ready(monkeypatch, tmp_path, changes):
    prepare(monkeypatch, tmp_path, ready_at=0, **changes)
    with pytest.raises(TimeoutError):
        waiter.wait_for_session(tmp_path, "frontend", PID, TOKEN)


def test_slow_process_observation_is_retried_within_the_same_deadline(monkeypatch, tmp_path):
    clock = prepare(monkeypatch, tmp_path)

    def stalled(pid, timeout):
        clock.now += timeout
        raise subprocess.TimeoutExpired("ps", timeout)

    monkeypatch.setattr(waiter, "process_is_running", stalled)
    with pytest.raises(TimeoutError):
        waiter.wait_for_session(tmp_path, "frontend", PID, TOKEN)
    assert clock.now == pytest.approx(10)


@pytest.mark.parametrize("state, expected", [("S", True), ("Z+", False), ("", False)])
def test_process_observation_rejects_zombies(monkeypatch, state, expected):
    monkeypatch.setattr(waiter.os, "kill", lambda pid, signal: None)
    monkeypatch.setattr(waiter.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout=state))
    assert waiter.process_is_running(PID, 0.5) is expected


def test_failure_reports_original_service_log(monkeypatch, tmp_path, capsys):
    (tmp_path / "scripts").mkdir()
    logs = tmp_path / ".logs"
    logs.mkdir()
    (logs / "frontend.log").write_text("Pixi activation: original failure detail\n", encoding="utf-8")
    monkeypatch.setattr(waiter, "__file__", str(tmp_path / "scripts/wait_service_session.py"))
    monkeypatch.setattr(waiter.sys, "argv", ["wait_service_session.py", "frontend", str(PID), TOKEN])
    monkeypatch.setattr(waiter, "process_is_running", lambda *args: False)
    assert waiter.main() == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert "bootstrap processが終了" in output.err
    assert "Pixi activation: original failure detail" in output.err


def test_empty_groups_and_owner_trees_are_safe_with_bash_nounset(tmp_path):
    helpers = Path(__file__).resolve().parents[2] / "scripts/process_helpers.sh"
    owner_file = tmp_path / "runtime_owner"
    owner_file.write_text("12345\n", encoding="utf-8")
    result = subprocess.run(
        ["/bin/bash", "-c", '''
set -euo pipefail
PROCESS_ROOT="$1"
source "$2"
# Model a just-exited bootstrap with no group members or owner children.
ps() { :; }
process_is_running() { return 0; }
process_is_owned() { return 0; }
kill() { echo "unexpected kill" >&2; exit 99; }
if process_group_has_generation_identity 12345 frontend aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; then
  exit 98
fi
terminate_runtime_owner_children "$3" 98765
[[ ! -e "$3" ]]
''', "_", str(tmp_path), str(helpers), str(owner_file)],
        capture_output=True, text=True, check=False, timeout=5,
    )
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
