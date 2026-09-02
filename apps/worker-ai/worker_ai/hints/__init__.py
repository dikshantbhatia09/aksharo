"""Glossary/spelling memory hints, shaped for the ASR providers (09 §3, B09)."""

from __future__ import annotations

from .glossary import MAX_HINT_LENGTH, MAX_HINTS_DEFAULT, prepare_hints

__all__ = ["MAX_HINTS_DEFAULT", "MAX_HINT_LENGTH", "prepare_hints"]
