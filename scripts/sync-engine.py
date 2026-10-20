#!/usr/bin/env python3
"""Copy canonical desktop inputs from one engine commit; --check never writes."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

PATHS = (
    "schemas/knotra-v1.schema.json",
    "docs/api/desktop-v1.openapi.json",
    "contracts/v1/fixtures",
    "examples/local",
    "examples/starter",
)
SOURCE = "https://github.com/knotra-dev/engine"


def snapshot(engine, revision):
    commit = subprocess.check_output(
        ["git", "-C", str(engine), "rev-parse", "--verify", revision + "^{commit}"],
        text=True,
    ).strip()
    archive = subprocess.check_output(
        ["git", "-C", str(engine), "archive", commit, *PATHS]
    )
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        for member in tree:
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("unsafe archive path: " + member.name)
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("expected a regular file: " + member.name)
            files[member.name] = tree.extractfile(member).read()
    manifest = {
        "repository": SOURCE,
        "commit": commit,
        "sha256": {
            name: hashlib.sha256(data).hexdigest()
            for name, data in sorted(files.items())
        },
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    return files


def check(destination, files):
    actual = {
        str(p.relative_to(destination)): p.read_bytes()
        for p in destination.rglob("*")
        if p.is_file()
    }
    return actual == files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", type=Path)
    parser.add_argument("revision", help="explicit engine commit or ref")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = snapshot(args.engine.resolve(), args.revision)
    destination = Path(__file__).resolve().parents[1] / "vendor/engine"
    if args.check:
        if not check(destination, files):
            parser.exit(1, "engine snapshot differs; run sync-engine.py without --check\n")
    else:
        staged = destination.with_name("engine.tmp")
        if staged.exists():
            parser.exit(1, f"remove leftover staging directory first: {staged}\n")
        staged.mkdir(parents=True)
        for name, data in files.items():
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if destination.exists():
            shutil.rmtree(destination)
        staged.rename(destination)
    print("engine snapshot matches " + json.loads(files["manifest.json"])["commit"])


if __name__ == "__main__":
    main()
