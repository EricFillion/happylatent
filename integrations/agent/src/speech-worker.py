"""Run the shared optional Kokoro worker from a checkout or installed bundle."""
import os
from pathlib import Path
import runpy
import sys


def main():
    here = Path(__file__).resolve()
    configured = os.environ.get("HAPPYLATENT_NODE_ROOT")
    roots = [Path(configured)] if configured else []
    if len(here.parents) > 3:
        roots.append(here.parents[3])
    roots.append(here.parent.parent / "resources" / "node")
    for root in roots:
        worker = root / "happylatent" / "speech_worker.py"
        if worker.is_file():
            runpy.run_path(str(worker), run_name="__main__")
            return
    print("The shared Happy Latent speech worker is missing. Reinstall the Happy Latent integration.", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
