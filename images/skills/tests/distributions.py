"""Distributions as an installer leaves them, and as a wheel carries them, for the tests of the Imports rule."""

import base64
import hashlib
import zipfile
from collections.abc import Mapping
from pathlib import Path


def _record_line(path: str, content: str) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(content.encode())}"


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
        records.append(_record_line(relative, content))
    records.append(f"{dist_info}/RECORD,,")
    (site_packages / dist_info / "RECORD").write_text("\n".join(records) + "\n")


def wheel(directory: Path, name: str, version: str, files: Mapping[str, str]) -> Path:
    """A pure-Python wheel of `name` at `version` holding `files`, written into `directory`; returns its path."""
    stem = name.replace("-", "_")
    dist_info = f"{stem}-{version}.dist-info"
    everything = {
        **files,
        f"{dist_info}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
        f"{dist_info}/WHEEL": "Wheel-Version: 1.0\nGenerator: cogmo-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    record = "\n".join(
        [*(_record_line(path, content) for path, content in everything.items()), f"{dist_info}/RECORD,,"]
    )
    path = directory / f"{stem}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(path, "w") as archive:
        for member, content in {**everything, f"{dist_info}/RECORD": f"{record}\n"}.items():
            archive.writestr(member, content)
    return path
