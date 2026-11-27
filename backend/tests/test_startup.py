"""The DSP-only server has to start on a machine without the AI runtimes."""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Optional heavy dependencies. The finder below makes importing them fail, so
# the test means the same thing on a machine where they happen to be installed.
HEAVY_MODULES = ["torch", "torchaudio", "onnxruntime", "fairseq", "faiss", "librosa", "rvc"]

BLOCKER = f"""
import importlib.abc
import sys


class _Blocked(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in {HEAVY_MODULES!r}:
            raise ModuleNotFoundError(f"No module named {{name!r}} (blocked by test)", name=name)
        return None


sys.meta_path.insert(0, _Blocked())
"""


def _run_without_heavy_modules(code: str) -> subprocess.CompletedProcess:
    blocker = BLOCKER
    return subprocess.run(
        [sys.executable, "-c", blocker + code],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=120,
    )


def test_app_imports_without_heavy_dependencies():
    result = _run_without_heavy_modules("import backend.main\n")
    assert result.returncode == 0, result.stderr
