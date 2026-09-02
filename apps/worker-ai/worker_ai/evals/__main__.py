"""``python -m worker_ai.evals run --set fixtures/hinglish-mini``.

Prints the per-item and corpus WER/CER table, or the same report as JSON with
``--json`` so the nightly harness can diff two runs. Exit code 1 when a WER
threshold is given with ``--max-wer`` and the corpus exceeds it — that is the hook
`09 §8` needs to block a routing change on a regression.

Every adapter can be scored, including the three vendors, because a vendor lane
replays its recorded session by default:

```
python -m worker_ai.evals run --set hinglish-mini --provider mock
python -m worker_ai.evals run --set hinglish-mini --provider sarvam        # replayed
python -m worker_ai.evals run --set hinglish-mini --provider sarvam --live # A00-06
```
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence

from worker_ai.evals.manifest import EvalManifestError, available_sets, load_eval_set
from worker_ai.evals.replay import build_replay_provider
from worker_ai.evals.runner import run_eval_set
from worker_ai.logging_setup import configure_logging
from worker_ai.providers.base import Provider
from worker_ai.providers.local_whisper import LocalWhisperProvider
from worker_ai.providers.mock import MockProvider
from worker_ai.providers.registry import build_registry
from worker_ai.settings import EnvValidationError, load_repo_dotenv, load_settings

__all__ = ["main"]

#: Adapters the harness can replay from recorded fixtures, so every vendor lane
#: is exercised end to end without a key (`09 §8`; keys arrive with A00-06).
REPLAYABLE = ("elevenlabs", "sarvam", "assemblyai", "serverless-whisper")


async def _provider(name: str, model: str, *, replay: str | None) -> Provider:
    """The provider the harness scores, live or replayed.

    ``--replay`` is the default for a vendor adapter: it serves the recorded
    session under ``worker_ai/fixtures/vendor/<name>``, so ``evals run --provider
    sarvam`` works on a laptop with no credentials. ``--live`` asks the registry
    for the configured adapter instead, which is the A00-06 smoke path.
    """
    if name == "mock":
        return MockProvider()
    if name == "local-whisper":
        return LocalWhisperProvider(model_name=model)
    if name not in REPLAYABLE:
        raise SystemExit(
            f"unknown provider {name!r}; the eval CLI runs mock, local-whisper or "
            + ", ".join(REPLAYABLE)
        )
    if replay is not None:
        provider, _session = build_replay_provider(name, replay or None)
        return provider

    load_repo_dotenv()
    try:
        settings = load_settings()
    except EnvValidationError as error:
        raise SystemExit(str(error)) from error
    registry = build_registry(settings)
    reason = registry.reason_disabled(name)
    if reason is not None:
        raise SystemExit(f"{name} cannot run live here: {reason}")
    return await registry.get(name)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m worker_ai.evals",
        description="Run an eval set and report WER/CER.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    run = subcommands.add_parser("run", help="score one eval set")
    run.add_argument("--set", required=True, help="set name or path under fixtures/")
    run.add_argument(
        "--provider",
        default="mock",
        help="mock (default), local-whisper, or " + ", ".join(REPLAYABLE),
    )
    run.add_argument("--model", default="small", help="model name for local-whisper")
    run.add_argument(
        "--replay",
        nargs="?",
        const="",
        default=None,
        metavar="FIXTURE",
        help=(
            "replay a recorded vendor session instead of calling the vendor; "
            "defaults to the provider's own fixture directory"
        ),
    )
    run.add_argument(
        "--live",
        action="store_true",
        help="call the configured vendor for real (needs a key; A00-06)",
    )
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
    replay = _replay_choice(arguments)
    provider = await _provider(arguments.provider, arguments.model, replay=replay)
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


def _replay_choice(arguments: argparse.Namespace) -> str | None:
    """Replay unless ``--live`` was asked for.

    A vendor adapter with no key would otherwise fail with a confusing message,
    and the whole point of the recorded sessions is that the harness runs
    anywhere.
    """
    if arguments.live:
        return None
    if arguments.replay is not None:
        return str(arguments.replay)
    if arguments.provider in REPLAYABLE:
        # An empty string means "the provider's own recorded session".
        return ""
    return None


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
