"""Python client for the local bridge protocol (C01, "Local bridge protocol (v2)").

Mirrors the subset of `packages/bridge-core/src/protocol.ts` this Resolve
script needs: the JSON-RPC 2.0 envelope, error codes, and the
`apply.begin`/`apply.step`/`apply.commit`/`apply.abort` + `transcript.push`
methods. TypeScript (`protocol.ts`) remains the source of truth; this module
must stay wire-compatible with it, not reinterpret it.
"""
