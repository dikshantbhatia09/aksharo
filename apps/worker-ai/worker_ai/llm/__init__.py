"""``ai.llm`` — chapters, summary, hooks/titles/hashtags (B11, CONTRACTS section 3).

This package is the Python side of the templates that live, canonically, in
``packages/prompts`` (TypeScript) — the same split as ``worker_ai.translate``
and ``@montaj/prompts``'s ``translate.ts``: the string templates and version
constants are mirrored here so a review of one is a review of both (a diff to
one without the other is the bug this doc comment exists to help a reviewer
catch), while the actual network call happens in this process
(CONTRACTS: "all AI runs in apps/worker-ai").

Layout:

``templates.py``    the four templates (chapters/summary/hooks/keyphrases),
                     mirroring ``packages/prompts/src/templates/*.ts`` byte for
                     byte on their version strings.
``schemas.py``       pydantic models the provider's JSON reply is validated
                     against, one repair attempt on failure.
``region.py``        region pinning: which provider/endpoint a workspace's
                     jurisdiction may call.
``providers/``       ``LlmProvider`` + the mock, Anthropic and OpenAI adapters.
``service.py``       orchestrates: build → call (retry) → validate (repair) →
                     return ``{templateId, version, provider, output, usage}``.
"""

from __future__ import annotations

from worker_ai.llm.service import LlmResult, generate_insight

__all__ = ["LlmResult", "generate_insight"]
