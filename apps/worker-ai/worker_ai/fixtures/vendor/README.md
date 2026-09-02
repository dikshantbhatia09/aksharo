# Recorded vendor exchanges

One directory per vendor, each holding a `session.json` that
`worker_ai/evals/replay.py` serves through an `httpx2.MockTransport`. The adapter
under test is the real adapter; only the socket is replaced.

**These files contain no credentials and never have.** Every base URL is a
`.test` host, every key in a recorded request is `replay-key`, and every body was
hand-written from the vendor's published API documentation (RR-02 F1 and F5 cite
the pages). Nothing here has been near a real account, because no account exists
yet — A00-06 signs the DPAs and issues the keys.

That is also the limitation to keep in mind: **a fixture proves the adapter, not
the vendor.** If a field name differs from what the docs showed, the fixture will
agree with the adapter and both will be wrong together. The README's "Vendor
smoke tests" section lists what to check first on the day the keys arrive, and
each adapter's module docstring states the wire contract it assumes so a
correction is a single, obvious edit.

| Directory | Vendor | What the session covers |
| --- | --- | --- |
| `elevenlabs/` | Scribe v2 | one `POST /v1/speech-to-text` with word timestamps and two speakers |
| `elevenlabs-alignment/` | Forced Alignment | one `POST /v1/forced-alignment` |
| `elevenlabs-rate-limited/` | Scribe v2 | a 429 with `Retry-After`, then success — the backoff path |
| `sarvam/` | Saaras v4 Batch | init, blob upload, start, two polls, output download |
| `sarvam-failed/` | Saaras v4 Batch | a job that reaches `Failed`, which must not be retried |
| `assemblyai/` | Universal-2 | upload, submit, one `processing` poll, then `completed` |
| `gpu-whisper/` | serverless GPU | one `POST /transcribe` (D15) |
