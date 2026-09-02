"""``python -m worker_ai.evals run --set fixtures/hinglish-mini``.

Prints the per-item and corpus WER/CER table, or the same report as JSON with
``--json`` so the nightly harness can diff two runs. Exit code 1 when a WER
threshold is given with ``--max-wer`` and the corpus exceeds it — that is the hook
`09 §8` needs to block a routing change on a regression.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence

from worker_ai.evals.manifest import EvalManifestError, available_sets, load_eval_set
from worker_ai.evals.runner import run_eval_set
from worker_ai.logging_setup import configure_logging
from worker_ai.providers.base import Provider
from worker_ai.providers.local_whisper import LocalWhisperProvider
from worker_ai.providers.mock import MockProvider

__all__ = ["main"]


def _provider(name: str, model: str) -> Provider:
    if name == "mock":
        return MockProvider()
    if name == "local-whisper":
        return LocalWhisperProvider(model_name=model)
    raise SystemExit(
        f"unknown provider {name!r}; the eval CLI runs 'mock' or 'local-whisper' "
        "(vendor adapters land in A10)"
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m worker_ai.evals",
        description="Run an eval set and report WER/CER.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    run = subcommands.add_parser("run", help="score one eval set")
    run.add_argument("--set", required=True, help="set name or path under fixtures/")
    run.add_argument("--provider", default="mock", help="mock (default) or local-whisper")
    run.add_argument("--model", default="small", help="model name for local-whisper")
    run.add_argument("--json", action="store_true", help="machine-readable output")
    run.add_argument(
        "--max-wer",
        type=float,
        default=None,
        help="exit 1 when the corpus WER exceeds this",
    )

    subcommands.add_parser("list", help="list the eval sets that ship with the worker")
    return parser


async def _run(arguments: argparse.Namespace) -> int:
    eval_set = load_eval_set(arguments.set)
    provider = _provider(arguments.provider, arguments.model)
    try:
        report = await run_eval_set(eval_set, provider)
    finally:
        await provider.aclose()

    print(json.dumps(report.to_wire(), indent=2) if arguments.json else report.table())

    if arguments.max_wer is not None and report.corpus_wer > arguments.max_wer:
        print(
            f"corpus WER {report.corpus_wer:.3f} exceeds the {arguments.max_wer:.3f} gate",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point; returns the process exit code."""
    configure_logging("worker-ai-evals")
    arguments = _parser().parse_args(argv)

    if arguments.command == "list":
        sets = available_sets()
        print("\n".join(sets) if sets else "no eval sets are installed")
        return 0

    try:
        return asyncio.run(_run(arguments))
    except EvalManifestError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
