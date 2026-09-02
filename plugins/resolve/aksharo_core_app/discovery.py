"""Discovery file for this script's own in-Resolve loopback server.

Same shape as `packages/bridge-core/src/discovery.ts`'s `~/.aksharo/bridge.json`
(port, bearer, pid, version, startedAt) but a distinct file
(`~/.aksharo/resolve.json`) so the desktop bridge and this Resolve script never
race each other's discovery file. Written with mode 0600 (owner read/write
only) because it carries the bearer token that authorises every route.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

DISCOVERY_DIR_NAME = ".aksharo"
DISCOVERY_FILE_NAME = "resolve.json"

LOOPBACK_PORT_RANGE = range(47841, 47844)  # 47841-47843 inclusive, per brief §1


@dataclass(frozen=True, slots=True)
class DiscoveryFile:
    port: int
    bearer: str
    pid: int
    version: str
    started_at: str

    def to_wire(self) -> dict[str, object]:
        return {
            "port": self.port,
            "bearer": self.bearer,
            "pid": self.pid,
            "version": self.version,
            "startedAt": self.started_at,
        }


def aksharo_dir() -> Path:
    return Path.home() / DISCOVERY_DIR_NAME


def discovery_file_path() -> Path:
    return aksharo_dir() / DISCOVERY_FILE_NAME


def generate_bearer_token() -> str:
    """A fresh, high-entropy bearer token: 256 bits, base64url (matches
    bridge-core's `generateBearerToken`)."""
    return secrets.token_urlsafe(32)


def write_discovery_file(file: DiscoveryFile, path: Path | None = None) -> None:
    """Writes the discovery file atomically with 0600 permissions."""
    target = path or discovery_file_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(target.parent, 0o700)
    tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(file.to_wire(), indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(target)  # atomic rename on POSIX; replaces the destination on Windows too
    target.chmod(0o600)


def read_discovery_file(path: Path | None = None) -> DiscoveryFile | None:
    target = path or discovery_file_path()
    if not target.exists():
        return None
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        return DiscoveryFile(
            port=raw["port"],
            bearer=raw["bearer"],
            pid=raw["pid"],
            version=raw["version"],
            started_at=raw["startedAt"],
        )
    except (json.JSONDecodeError, KeyError, OSError, TypeError):
        return None
