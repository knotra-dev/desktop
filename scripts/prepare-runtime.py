#!/usr/bin/env python3
"""Build the engine and Linux sandbox helpers into the native app's resources."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    "aarch64-apple-darwin": ("darwin", "arm64"),
    "x86_64-apple-darwin": ("darwin", "amd64"),
    "aarch64-unknown-linux-gnu": ("linux", "arm64"),
    "x86_64-unknown-linux-gnu": ("linux", "amd64"),
    "aarch64-unknown-linux-musl": ("linux", "arm64"),
    "x86_64-unknown-linux-musl": ("linux", "amd64"),
    "aarch64-pc-windows-msvc": ("windows", "arm64"),
    "x86_64-pc-windows-msvc": ("windows", "amd64"),
}


def target_platform(target=None):
    if target:
        if target not in TARGETS:
            raise ValueError(f"unsupported desktop target: {target}")
        return TARGETS[target]
    os_name = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(
        platform.system()
    )
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(
        platform.machine()
    )
    if not os_name or not arch:
        raise ValueError("only macOS, Linux and Windows on x64/ARM64 are supported")
    return os_name, arch


def prepare(source, destination, target):
    if not (source / "go.mod").is_file():
        raise ValueError(f"engine source not found at {source}; set KNOTRA_ENGINE_SOURCE")
    # A published engine predating these adapters cannot power this Desktop build.
    help_text = subprocess.check_output(
        ["go", "run", "-mod=readonly", "./cmd/knotra", "quickstart", "--help"],
        cwd=source,
        text=True,
    )
    for feature in ("openai-compatible", "codex", "claude", "--base-url", "--no-run", "--connections-file"):
        if feature not in help_text:
            raise ValueError(f"engine source lacks {feature}; use the matching engine revision")
    try:
        mcp_help = subprocess.check_output(
            ["go", "run", "-mod=readonly", "./cmd/knotra", "mcp", "discover", "--help"],
            cwd=source, text=True, stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        raise ValueError("engine source lacks MCP discovery; use the matching engine revision") from error
    if "List an HTTP MCP server" not in mcp_help or "--json" not in mcp_help:
        raise ValueError("engine source lacks MCP discovery; use the matching engine revision")
    try:
        control_help = subprocess.check_output(
            ["go", "run", "-mod=readonly", "./cmd/knotra", "mcp", "serve", "--help"],
            cwd=source, text=True, stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as error:
        raise ValueError("engine source lacks desktop MCP control; use the matching engine revision") from error
    if "--desktop" not in control_help or "--bridge-file" not in control_help:
        raise ValueError("engine source lacks desktop MCP control; use the matching engine revision")
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=source, text=True
    ).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=source))
    os_name, arch = target
    version = commit[:12] + ("-dirty" if dirty else "")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=destination.parent) as directory:
        staged = Path(directory)
        for name, goos, goarch, package in (
            ("knotra.exe" if os_name == "windows" else "knotra", os_name, arch, "./cmd/knotra"),
            ("sandbox-helper-linux-amd64", "linux", "amd64", "./internal/adapters/sandboxhelper"),
            ("sandbox-helper-linux-arm64", "linux", "arm64", "./internal/adapters/sandboxhelper"),
        ):
            subprocess.run(
                ["go", "build", "-mod=readonly", "-trimpath", "-ldflags", f"-X main.version={version}",
                 "-o", str(staged / name), package],
                cwd=source,
                env={**os.environ, "CGO_ENABLED": "0", "GOOS": goos, "GOARCH": goarch},
                check=True,
            )
        identity = os.environ.get("APPLE_SIGNING_IDENTITY")
        if os_name == "darwin" and identity:
            # Tauri signs sidecars automatically, but this engine is a resource.
            signing = ["codesign", "--force", "--sign", identity]
            if identity != "-":
                signing.extend(["--options", "runtime", "--timestamp"])
            subprocess.run([*signing, str(staged / "knotra")], check=True)
        shutil.copyfile(source / "LICENSE", staged / "LICENSE")
        shutil.copyfile(ROOT / "src-tauri/account-clis.json", staged / "account-clis.json")
        manifest = {
            "repository": "https://github.com/knotra-dev/engine",
            "commit": commit,
            "dirty": dirty,
            "platform": f"{os_name}-{arch}",
            "sha256": {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(staged.iterdir())
            },
        }
        (staged / "runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
        destination.mkdir(exist_ok=True)
        for path in destination.iterdir():
            if path.name != ".gitkeep":
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
        for path in staged.iterdir():
            shutil.move(path, destination / path.name)
    print(f"Prepared {os_name}-{arch} runtime from engine {version}: {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-source", type=Path,
                        default=Path(os.environ.get("KNOTRA_ENGINE_SOURCE", ROOT.parent / "engine")))
    parser.add_argument("--target", default=os.environ.get("TAURI_ENV_TARGET_TRIPLE"))
    args = parser.parse_args()
    try:
        prepare(args.engine_source.resolve(), ROOT / "src-tauri/runtime", target_platform(args.target))
    except (ValueError, FileNotFoundError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"runtime preparation failed: {error}\n")


if __name__ == "__main__":
    main()
