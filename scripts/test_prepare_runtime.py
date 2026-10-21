import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlparse


spec = importlib.util.spec_from_file_location(
    "prepare_runtime", Path(__file__).with_name("prepare-runtime.py")
)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTest(unittest.TestCase):
    def test_cross_build_ships_native_engine_and_both_linux_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "engine"
            source.mkdir()
            (source / "go.mod").write_text("module fixture\n")
            (source / "LICENSE").write_text("Fixture license\n")
            output = Path(directory) / "runtime"
            builds = []

            def build(args, **kwargs):
                builds.append((kwargs["env"]["GOOS"], kwargs["env"]["GOARCH"]))
                Path(args[args.index("-o") + 1]).write_bytes(b"fixture binary")

            with patch.object(
                subprocess,
                "check_output",
                side_effect=[
                    "openai-compatible codex claude --base-url --no-run --connections-file",
                    "List an HTTP MCP server --json",
                    "--desktop --bridge-file",
                    "a" * 40,
                    b" M model.go\n",
                ],
            ), patch.object(subprocess, "run", side_effect=build):
                runtime.prepare(
                    source,
                    output,
                    runtime.target_platform("x86_64-pc-windows-msvc"),
                )

            self.assertEqual(
                builds,
                [("windows", "amd64"), ("linux", "amd64"), ("linux", "arm64")],
            )
            manifest = json.loads((output / "runtime.json").read_text())
            self.assertTrue(manifest["dirty"])
            self.assertEqual(manifest["platform"], "windows-amd64")
            self.assertEqual(
                set(manifest["sha256"]),
                {
                    "knotra.exe",
                    "sandbox-helper-linux-amd64",
                    "sandbox-helper-linux-arm64",
                    "LICENSE",
                    "account-clis.json",
                },
            )
            for name, digest in manifest["sha256"].items():
                self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest(), digest)

    def test_missing_provider_does_not_replace_existing_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "go.mod").write_text("module fixture\n")
            output = source / "runtime"
            output.mkdir()
            (output / "knotra").write_bytes(b"previous build")
            with patch.object(subprocess, "check_output", return_value="ollama openai anthropic"):
                with self.assertRaisesRegex(ValueError, "lacks openai-compatible"):
                    runtime.prepare(source, output, ("darwin", "arm64"))
            self.assertEqual((output / "knotra").read_bytes(), b"previous build")

    def test_missing_mcp_discovery_does_not_replace_a_compatible_legacy_bundle(self):
        for response in ["unknown legacy help", subprocess.CalledProcessError(1, ["go", "run"])]:
            with self.subTest(response=type(response).__name__), tempfile.TemporaryDirectory() as directory:
                source = Path(directory)
                (source / "go.mod").write_text("module fixture\n")
                output = source / "runtime"
                output.mkdir()
                (output / "knotra").write_bytes(b"previous build")
                with patch.object(
                    subprocess,
                    "check_output",
                    side_effect=[
                        "openai-compatible codex claude --base-url --no-run --connections-file",
                        response,
                    ],
                ) as check, patch.object(subprocess, "run") as build:
                    with self.assertRaisesRegex(ValueError, "lacks MCP discovery"):
                        runtime.prepare(source, output, ("darwin", "arm64"))
                self.assertEqual(check.call_args.args[0][-3:], ["mcp", "discover", "--help"])
                build.assert_not_called()
                self.assertEqual((output / "knotra").read_bytes(), b"previous build")

    def test_missing_desktop_control_does_not_replace_a_compatible_mcp_bundle(self):
        for response in ["legacy MCP help", subprocess.CalledProcessError(1, ["go", "run"])]:
            with self.subTest(response=type(response).__name__), tempfile.TemporaryDirectory() as directory:
                source = Path(directory)
                (source / "go.mod").write_text("module fixture\n")
                output = source / "runtime"
                output.mkdir()
                (output / "knotra").write_bytes(b"previous build")
                with patch.object(
                    subprocess,
                    "check_output",
                    side_effect=[
                        "openai-compatible codex claude --base-url --no-run --connections-file",
                        "List an HTTP MCP server --json",
                        response,
                    ],
                ) as check, patch.object(subprocess, "run") as build:
                    with self.assertRaisesRegex(ValueError, "lacks desktop MCP control"):
                        runtime.prepare(source, output, ("darwin", "arm64"))
                self.assertEqual(check.call_args.args[0][-3:], ["mcp", "serve", "--help"])
                build.assert_not_called()
                self.assertEqual((output / "knotra").read_bytes(), b"previous build")

    def test_mac_signing_uses_explicit_identity_before_recording_hashes(self):
        for identity in ["-", "Developer ID Application: Test"]:
            with self.subTest(identity=identity), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "engine"
                source.mkdir()
                (source / "go.mod").write_text("module fixture\n")
                (source / "LICENSE").write_text("Fixture license\n")
                output = Path(directory) / "runtime"
                commands = []

                def run(args, **kwargs):
                    commands.append(args)
                    if args[0] == "go":
                        Path(args[args.index("-o") + 1]).write_bytes(b"unsigned")
                    else:
                        Path(args[-1]).write_bytes(b"signed")

                with (
                    patch.dict(os.environ, {"APPLE_SIGNING_IDENTITY": identity}),
                    patch.object(
                        subprocess,
                        "check_output",
                        side_effect=[
                            "openai-compatible codex claude --base-url --no-run --connections-file",
                            "List an HTTP MCP server --json",
                            "--desktop --bridge-file",
                            "a" * 40,
                            b"",
                        ],
                    ),
                    patch.object(subprocess, "run", side_effect=run),
                ):
                    runtime.prepare(source, output, ("darwin", "arm64"))

                self.assertEqual(commands[-1][:4], ["codesign", "--force", "--sign", identity])
                self.assertEqual("--timestamp" in commands[-1], identity != "-")
                self.assertEqual("--options" in commands[-1], identity != "-")
                manifest = json.loads((output / "runtime.json").read_text())
                self.assertEqual(manifest["sha256"]["knotra"], hashlib.sha256(b"signed").hexdigest())

    def test_account_downloads_are_pinned_to_official_https_assets(self):
        manifest = json.loads((runtime.ROOT / "src-tauri/account-clis.json").read_text())
        platforms = {
            "darwin-arm64",
            "darwin-amd64",
            "linux-arm64",
            "linux-amd64",
            "windows-arm64",
            "windows-amd64",
        }

        for provider, release in manifest.items():
            self.assertRegex(release["version"], r"^\d+\.\d+\.\d+$")
            self.assertEqual(set(release["platforms"]), platforms)
            for target, asset in release["platforms"].items():
                url = urlparse(asset["url"])
                self.assertEqual(url.scheme, "https")
                self.assertEqual(
                    url.hostname,
                    "github.com" if provider == "codex" else "downloads.claude.ai",
                )
                self.assertIn(release["version"], url.path)
                self.assertRegex(asset["sha256"], r"^[a-f0-9]{64}$")
                self.assertGreater(asset["size"], 1_000_000)
                self.assertEqual(Path(asset["executable"]).name, asset["executable"])
                self.assertEqual(
                    asset["archive"],
                    "raw" if provider == "claude" or target.startswith("windows") else "tar.gz",
                )


if __name__ == "__main__":
    unittest.main()
