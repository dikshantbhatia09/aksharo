"""Object-store access and the storage keys of ``docs/CONTRACTS.md`` section 6.

```
raw     (S3) ws/{workspaceId}/p/{projectId}/media/{mediaId}/raw.{ext}
derived (R2) ws/{workspaceId}/p/{projectId}/media/{mediaId}/{audio16k.wav|...}
exports (R2) ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}
fonts   (R2) ws/{workspaceId}/fonts/{fontId}.{ttf|otf|woff2}
```

The AI worker only ever **reads** derived media: ``audio16k.wav`` written by
``apps/worker-media``. It never writes to a bucket and never touches raw uploads,
so the raw client exists for symmetry and for the probe path A10 may need.

boto3 ships no type information, so nothing from it appears in a signature here:
:class:`S3Client` is the narrow protocol this module actually uses, which keeps
``mypy --strict`` with ``disallow_any_unimported`` honest and makes the store
trivially fakeable in tests.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from worker_ai.logging_setup import get_logger
from worker_ai.settings import BucketSettings

__all__ = [
    "DERIVED_ARTEFACTS",
    "DerivedArtefact",
    "ObjectStore",
    "S3Client",
    "StorageError",
    "clean_audio_key",
    "clean_preview_key",
    "derived_key",
    "export_key",
    "font_key",
    "media_prefix",
    "raw_key",
    "thumb_key",
]

_log = get_logger(__name__)

#: The derived artefacts CONTRACTS section 6 names, minus the numbered thumbnails.
DerivedArtefact = Literal[
    "audio16k.wav", "audio48k.wav", "proxy540.mp4", "waveform.json", "faces.json"
]

DERIVED_ARTEFACTS: tuple[DerivedArtefact, ...] = (
    "audio16k.wav",
    "audio48k.wav",
    "proxy540.mp4",
    "waveform.json",
    #: `ai.faces`: where faces are, over time, for face-aware caption placement.
    "faces.json",
)

#: ULIDs are Crockford base32, 26 characters. Ids reach this module from a job
#: payload, so they are validated before they are ever pasted into a key.
_ID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_EXT = re.compile(r"^[a-z0-9]{1,8}$")


class StorageError(RuntimeError):
    """A key was malformed, or an object could not be read."""


def _checked(kind: str, value: str) -> str:
    if not _ID.match(value):
        raise StorageError(f"{kind} is not a ULID")
    return value


def media_prefix(workspace_id: str, project_id: str, media_id: str) -> str:
    """``ws/{workspaceId}/p/{projectId}/media/{mediaId}`` — the shared prefix."""
    return (
        f"ws/{_checked('workspaceId', workspace_id)}"
        f"/p/{_checked('projectId', project_id)}"
        f"/media/{_checked('mediaId', media_id)}"
    )


def raw_key(workspace_id: str, project_id: str, media_id: str, ext: str) -> str:
    """Raw upload key in the S3 bucket."""
    clean = ext.lower().lstrip(".")
    if not _EXT.match(clean):
        raise StorageError(f"{ext!r} is not a usable file extension")
    return f"{media_prefix(workspace_id, project_id, media_id)}/raw.{clean}"


def derived_key(
    workspace_id: str, project_id: str, media_id: str, artefact: DerivedArtefact
) -> str:
    """Derived-media key in the R2 bucket."""
    if artefact not in DERIVED_ARTEFACTS:
        raise StorageError(f"{artefact!r} is not a CONTRACTS section 6 derived artefact")
    return f"{media_prefix(workspace_id, project_id, media_id)}/{artefact}"


#: `cleanId` is a client ULID (SetAudio, B10); validated the same as any other id.
def clean_audio_key(workspace_id: str, project_id: str, media_id: str, clean_id: str) -> str:
    """B10's output key: ``clean48k-{cleanId}.wav`` next to the source's derived media.

    Not one of :data:`DERIVED_ARTEFACTS` because it is per-clean-run rather than
    per-media — a project can hold more than one completed clean (undo, A/B) and
    each keeps its own object rather than overwriting the last one.
    """
    checked_id = _checked("cleanId", clean_id)
    return f"{media_prefix(workspace_id, project_id, media_id)}/clean48k-{checked_id}.wav"


def clean_preview_key(
    workspace_id: str,
    project_id: str,
    media_id: str,
    clean_id: str,
    variant: Literal["original", "cleaned"],
) -> str:
    """The 20 s A/B preview clip: ``preview-{cleanId}-{original|cleaned}.mp3``."""
    return (
        f"{media_prefix(workspace_id, project_id, media_id)}"
        f"/preview-{_checked('cleanId', clean_id)}-{variant}.mp3"
    )


def thumb_key(workspace_id: str, project_id: str, media_id: str, index: int) -> str:
    """``thumb-{n}.jpg`` in the R2 bucket."""
    if index < 0:
        raise StorageError("thumbnail index must not be negative")
    return f"{media_prefix(workspace_id, project_id, media_id)}/thumb-{index}.jpg"


def export_key(workspace_id: str, project_id: str, export_id: str, ext: str) -> str:
    """Export key in the R2 bucket."""
    clean = ext.lower().lstrip(".")
    if not _EXT.match(clean):
        raise StorageError(f"{ext!r} is not a usable file extension")
    return (
        f"ws/{_checked('workspaceId', workspace_id)}"
        f"/p/{_checked('projectId', project_id)}"
        f"/exports/{_checked('exportId', export_id)}.{clean}"
    )


def font_key(workspace_id: str, font_id: str, ext: Literal["ttf", "otf", "woff2"]) -> str:
    """Workspace font key in the R2 bucket."""
    if ext not in {"ttf", "otf", "woff2"}:
        raise StorageError(f"{ext!r} is not a permitted font extension")
    return f"ws/{_checked('workspaceId', workspace_id)}/fonts/{_checked('fontId', font_id)}.{ext}"


class S3Client(Protocol):
    """The slice of the boto3 S3 client this worker uses."""

    def download_file(self, Bucket: str, Key: str, Filename: str) -> None:  # noqa: N803
        """Download an object to a local path."""
        ...

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        """Object metadata; raises when the object does not exist."""
        ...

    def upload_file(self, Filename: str, Bucket: str, Key: str) -> None:  # noqa: N803
        """Upload a local path to an object. B10 is the first writer this worker has."""
        ...


@dataclass(frozen=True, slots=True)
class ObjectStore:
    """One configured bucket, plus the two operations the pipeline performs.

    Construct with :meth:`from_settings` in production and with an explicit
    ``client`` in tests — no network, no credentials, no moto.
    """

    bucket: str
    client: S3Client

    @classmethod
    def from_settings(cls, settings: BucketSettings) -> ObjectStore:
        """Build a client for an S3-compatible endpoint (R2, MinIO, AWS)."""
        if not settings.configured:
            raise StorageError(
                "object store is not configured: endpoint, bucket and credentials are required"
            )
        import boto3  # imported here so `import worker_ai` stays cheap
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=settings.endpoint,
            region_name=settings.region,
            aws_access_key_id=settings.access_key,
            aws_secret_access_key=settings.secret_key,
            # R2 and MinIO both want path-style addressing; SigV4 is what R2 requires.
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3, "mode": "standard"},
            ),
        )
        return cls(bucket=settings.bucket, client=client)

    def download(self, key: str, destination: Path) -> Path:
        """Fetch one object to ``destination``, creating parent directories."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.client.download_file(Bucket=self.bucket, Key=key, Filename=str(destination))
        except Exception as error:  # boto3 raises ClientError and friends
            raise StorageError(f"could not read {self.bucket}/{key}: {error}") from error
        _log.debug("downloaded object", extra={"bucket": self.bucket, "key": key})
        return destination

    def upload(self, path: Path, key: str) -> str:
        """Write a local file to ``key``. Used only by B10's ``ai.clean`` output.

        Every other processor in this worker only reads the derived bucket
        (module docstring); B10 is the first one that produces derived media
        rather than consuming it, so this is the one write path here.
        """
        try:
            self.client.upload_file(Filename=str(path), Bucket=self.bucket, Key=key)
        except Exception as error:  # boto3 raises ClientError and friends
            raise StorageError(f"could not write {self.bucket}/{key}: {error}") from error
        _log.debug("uploaded object", extra={"bucket": self.bucket, "key": key})
        return key

    def size_bytes(self, key: str) -> int:
        """``ContentLength`` of one object; used for egress accounting."""
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            raise StorageError(f"could not stat {self.bucket}/{key}: {error}") from error
        return int(head.get("ContentLength", 0))
