"""Make the project root importable (cloud_sync lives alongside decision/).

Adapted from the original ttc_daemon layout during the 2026-08-04 split:
``decision/`` now sits at the project root, so the project root itself
(instead of ``<repo>/candidate-collector``) is added to ``sys.path``.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
