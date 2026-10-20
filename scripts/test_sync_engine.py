import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "sync_engine", Path(__file__).with_name("sync-engine.py")
)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SnapshotTest(unittest.TestCase):
    def test_snapshot_uses_committed_bytes_and_detects_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            for name in sync.PATHS:
                path = repo / name
                if not path.suffix:
                    path /= "fixture.txt"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("committed\n")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(
                ["git", "-C", str(repo), "-c", "user.name=Test", "-c",
                 "user.email=test@example.invalid", "commit", "-qm", "Fixture"],
                check=True,
            )
            (repo / sync.PATHS[0]).write_text("uncommitted\n")
            files = sync.snapshot(repo, "HEAD")
            self.assertEqual(files[sync.PATHS[0]], b"committed\n")
            output = repo / "output"
            for name, data in files.items():
                path = output / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            self.assertTrue(sync.check(output, files))
            (output / sync.PATHS[0]).write_text("changed")
            self.assertFalse(sync.check(output, files))


if __name__ == "__main__":
    unittest.main()
