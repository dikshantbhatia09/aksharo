# speech-5s — a five-second synthetic speech fixture (CC0)

`clip.wav` is 5.00 s of 16 kHz mono PCM: a source-filter synthesis with a
wandering pitch, moving formants, a five-per-second syllable rate, three stop
closures and two breath gaps. `make_clip.py` regenerates it byte for byte from a
fixed seed, and `LICENSE` dedicates it to the public domain under CC0-1.0.

## What it is for

Two things needed a real audio file rather than a tone:

1. **The `slow` LocalWhisper test.** Without media it asserted nothing about the
   model it never fed; with this clip it decodes real audio through
   faster-whisper and checks the adapter's contract — a language, a duration, and
   timings inside the clip.
2. **The eval harness's vendor lanes.** A set with no media is skipped for any
   provider that reads audio (`evals/runner.py`), which was every vendor. The
   `vendor-replay` set points at this clip so `evals run --provider sarvam`
   exercises the whole adapter, replayed.

## What it is not

**It is not speech**, and no ASR model will find words in it. That is deliberate:
this fixture proves the *pipeline* — decode, VAD, chunk, submit, parse — not the
*quality* of anything. Quality needs the hand-labelled sets of `09 §8`, which are
**A00-05**'s deliverable: 5 h of Hinglish creator speech with word timings and
code-switch tags, 22 Indic languages, Indian English, global English and a noisy
set. Nothing here substitutes for them, and no routing weight may be changed on
the strength of this file.
