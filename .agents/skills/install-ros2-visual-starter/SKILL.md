---
name: install-ros2-visual-starter
description: Safely install and verify ROS2 Visual Starter OSS on its supported macOS Apple Silicon environment. Use when the user asks to install, set up, bootstrap, prepare, or verify this repository for first use.
---

# Install ROS2 Visual Starter OSS

Use this skill only for installing or verifying this repository. Keep the repository's existing security and support boundaries intact. If the user explicitly asks to change those boundaries or modify the installer itself, treat that as a separate code-change task instead of improvising during installation.

## Goal

Prepare the repository with its reviewed local installer, verify the resulting environment, and leave the user with a clear next command. Do not invent a parallel installation path.

## Safety rules

- Use the repository's `./setup.sh` as the only installation entrypoint.
- Do not install Pixi, Node.js, Python, ROS 2, Nav2, SLAM Toolbox, or Vision dependencies independently when `./setup.sh` is available.
- Do not use `sudo`, a system package manager, a language-level global installer, a remote installer, or a download piped to a shell as a fallback.
- Do not bypass checksum, version, lockfile, platform, or localhost-only checks.
- Do not use CI-only platform overrides to make an unsupported machine look supported.
- Do not change listener addresses, ports, firewall rules, proxy settings, ROS discovery scope, or Local LLM settings to make installation pass.
- Do not run destructive Git commands, discard local changes, delete user files, or rewrite repository history.
- Do not print environment secrets, tokens, credentials, or unrelated local configuration.
- Installation must not require modifying tracked source files. Generated dependencies, caches, logs, downloaded verified assets, and maps may be created only through repository-provided scripts.

## Workflow

### 1. Confirm the repository and preserve local work

Run non-destructive checks from the repository working tree:

```bash
git rev-parse --show-toplevel
git status --short
```

Confirm that `README.md`, `setup.sh`, `run.sh`, `stop.sh`, and `scripts/doctor.sh` exist. If the working tree already has changes, report that fact and preserve them. Do not reset, clean, stash, or overwrite them automatically.

### 2. Check the supported platform and prerequisites

Run:

```bash
uname -s
uname -m
command -v git
command -v curl
```

The supported OSS v1 installation target is `Darwin` + `arm64` (macOS Apple Silicon). If the machine is not that platform, do not run the installer and do not use a CI override. Explain that Linux, Windows, and Intel Mac are not validated release targets for this version.

If `git` or `curl` is missing, report the missing prerequisite. Do not install system tools automatically.

### 3. Install through the reviewed entrypoint

Run exactly:

```bash
./setup.sh
```

Allow `setup.sh` to perform its own verified Pixi bootstrap and locked dependency installation. Do not replace any failed step with a different installer or an unpinned dependency command.

If setup fails, preserve the original error output. Inspect `README.md`, `docs/TROUBLESHOOTING.md`, `setup.sh`, and relevant repository logs as needed, but do not weaken a verification or network boundary to continue.

### 4. Verify the installed environment

Run:

```bash
./scripts/doctor.sh
```

Treat any failed doctor check as an installation problem that still needs resolution. Do not report success while a required check is failing.

For additional non-persistent SIM verification when appropriate, use the repository's existing smoke test rather than inventing a new launcher sequence:

```bash
./scripts/ci_sim_smoke.sh
```

### 5. Finish without leaving an unexpected runtime behind

Do not start ROS, Mapping, Navigation, Exploration, or the optional Local LLM unless the user explicitly asked for it. If a runtime was started for verification, stop it with the repository entrypoint:

```bash
./stop.sh
```

For a normal first launch, tell the user the next command is:

```bash
./run.sh --sim
```

The supported browser endpoint is `http://127.0.0.1:27182/`. Do not expose it on a LAN or the Internet.

## Failure handling

When a command fails:

1. State which command failed and preserve the useful error text.
2. Determine whether the failure is an unsupported platform, missing prerequisite, integrity/version check, dependency installation problem, port/process conflict, or doctor failure.
3. Prefer repository documentation and repository-provided diagnostics.
4. Make only reversible, installation-scoped fixes that do not weaken security controls or modify tracked project behavior.
5. If the only apparent workaround requires bypassing a checksum, lockfile, supported-platform check, localhost binding, or other security boundary, stop and explain the blocker instead.

## Completion report

Respond in the user's language. Keep the report concise and include:

- detected OS and architecture;
- whether `./setup.sh` succeeded;
- whether `./scripts/doctor.sh` succeeded;
- whether an optional SIM smoke check was run and its result;
- any remaining blocker;
- the next command, normally `./run.sh --sim`.

Never claim installation is complete solely because dependencies downloaded successfully; verification must also pass.