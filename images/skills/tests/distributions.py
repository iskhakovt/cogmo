"""Distributions as an installer leaves them, for the tests of the Imports rule."""

import base64
import hashlib
from collections.abc import Mapping
from pathlib import Path


def install(site_packages: Path, name: str, files: Mapping[str, str]) -> None:
    """Lay `name`'s `files` out in `site_packages` as an installer does, with a `RECORD` listing each."""
    dist_info = f"{name.replace('-', '_')}-1.0.dist-info"
    everything = {**files, f"{dist_info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n"}
    records = []
    for relative, content in everything.items():
        path = site_packages / relative
        if not relative.startswith(".."):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b"=").decode()
        records.append(f"{relative},sha256={digest},{len(content.encode())}")
    records.append(f"{dist_info}/RECORD,,")
    (site_packages / dist_info / "RECORD").write_text("\n".join(records) + "\n")
