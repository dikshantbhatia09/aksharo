# Aksharo test platform profiles

The four `platform-profile@1` fixtures are preparatory only: Instagram Reel,
YouTube Short, LinkedIn video, and TikTok video. Each is `test_only`, disabled,
and limited to a `download_only` fallback. Desired direct/scheduled modes are
ideas for later review, not proven permissions. The registry is not imported by
the API, web app, renderer, or publishing adapter.

The 3–60 second, 250 MB MP4/H.264/AAC `preparation` bounds are conservative
Aksharo MVP export choices, not statements of each provider's maximum. Source
URLs were checked against official platform/owner documentation on 2026-09-15.
TikTok duration and privacy constraints need a live creator-info check; all
profiles require live account-capability validation.

The schema rejects accidental direct/schedule enablement without protected
references for credential owner, scopes, app review, test account, staging
smoke, and verification time. Structurally valid references are not proof that
those documents exist or that a provider has granted access. Wave 0 evidence,
cross-owner review, and staging post IDs remain activation gates.
