"""Run opt-in backend performance tests with a portable environment variable."""

import os
import subprocess
import sys


def main() -> int:
    env = os.environ.copy()
    env["RUN_PERFORMANCE_TESTS"] = "true"
    command = [
        sys.executable,
        "-m",
        "pytest",
        "backend/tests/test_performance.py",
        "-q",
    ]
    return subprocess.call(command, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
