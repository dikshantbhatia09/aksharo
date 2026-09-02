"""Signed callbacks, verified against a server that implements CONTRACTS section 3."""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import httpx2
import pytest

from worker_ai.callbacks import (
    ATTEMPT_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    CallbackClient,
    CallbackError,
    JobCompletion,
    JobError,
    JobUsage,
    encode_body,
    sign_request,
    signature_headers,
)

from .conftest import ATTEMPT_ID, CALLBACK_SECRET, JOB_ID, FakeApi


def test_signature_matches_the_typescript_formula() -> None:
    """`hex(hmac_sha256(secret, timestamp + "." + rawBody))`, byte for byte."""
    body = b'{"status":"succeeded"}'
    expected = hmac.new(
        CALLBACK_SECRET.encode("utf-8"), b"1767225600." + body, hashlib.sha256
    ).hexdigest()
    assert sign_request(CALLBACK_SECRET, 1767225600, body) == expected
    # The timestamp is stringified, so an int and its string must agree.
    assert sign_request(CALLBACK_SECRET, "1767225600", body) == expected


def test_body_is_serialised_the_way_json_stringify_is() -> None:
    """No spaces after separators, and non-ASCII kept as characters."""
    assert encode_body({"a": 1, "b": "नमस्ते"}) == '{"a":1,"b":"नमस्ते"}'.encode()


def test_body_refuses_nan_rather_than_sending_invalid_json() -> None:
    with pytest.raises(ValueError, match="Out of range float"):
        encode_body({"progress": float("nan")})


def test_headers_carry_unix_seconds_and_the_attempt_id() -> None:
    body = encode_body({"progress": 50})
    headers = signature_headers(secret=CALLBACK_SECRET, attempt_id=ATTEMPT_ID, body=body)
    assert headers[ATTEMPT_HEADER] == ATTEMPT_ID
    assert headers["content-type"] == "application/json"
    seconds = int(headers[TIMESTAMP_HEADER])
    # Unix seconds, not milliseconds: the API rejects anything >= 1e11.
    assert 1_600_000_000 < seconds < 100_000_000_000
    assert abs(seconds - time.time()) < 5
    assert headers[SIGNATURE_HEADER] == sign_request(CALLBACK_SECRET, seconds, body)


async def test_progress_is_accepted_by_a_contract_server(fake_api: FakeApi) -> None:
    async with CallbackClient(fake_api.origin, CALLBACK_SECRET) as client:
        ack = await client.progress(JOB_ID, ATTEMPT_ID, 42.5, eta_ms=9_000, message="halfway")

    assert ack.applied is True
    call = fake_api.progresses()[0]
    assert call.path == f"/internal/jobs/{JOB_ID}/progress"
    assert call.attempt_id == ATTEMPT_ID
    assert call.signature_matches(CALLBACK_SECRET)
    assert call.json == {"progress": 42.5, "etaMs": 9_000, "message": "halfway"}


async def test_completion_carries_result_usage_and_final_attempt(fake_api: FakeApi) -> None:
    completion = JobCompletion(
        status="failed",
        error=JobError(code="worker/provider_failed", message="429 from vendor"),
        usage=JobUsage(media_seconds=61.25, provider="sarvam", model="saaras-v4", cost_minor=54),
        final_attempt=True,
    )
    async with CallbackClient(fake_api.origin, CALLBACK_SECRET) as client:
        await client.complete(JOB_ID, ATTEMPT_ID, completion)

    body = fake_api.completions()[0].json
    assert body["status"] == "failed"
    assert body["error"] == {
        "code": "worker/provider_failed",
        "message": "429 from vendor",
        "retryable": True,
    }
    assert body["usage"] == {
        "mediaSeconds": 61.25,
        "provider": "sarvam",
        "model": "saaras-v4",
        "costMinor": 54,
    }
    assert body["finalAttempt"] is True


async def test_a_replay_is_reported_not_raised(fake_api: FakeApi) -> None:
    """`applied: false` is the API saying "already recorded", which is a success."""
    fake_api.applied = False
    async with CallbackClient(fake_api.origin, CALLBACK_SECRET) as client:
        ack = await client.complete(JOB_ID, ATTEMPT_ID, JobCompletion(status="succeeded"))
    assert ack.applied is False


async def test_a_wrong_secret_is_rejected_by_the_server(fake_api: FakeApi) -> None:
    async with CallbackClient(fake_api.origin, "b" * 64) as client:
        with pytest.raises(CallbackError) as raised:
            await client.complete(JOB_ID, ATTEMPT_ID, JobCompletion(status="succeeded"))
    assert raised.value.status_code == 401
    # 401 is not retried: it can never start working inside the signature window.
    assert len(fake_api.calls) == 1


async def test_a_5xx_is_retried_and_re_signed(fake_api: FakeApi) -> None:
    fake_api.responses = [503, 500]
    async with CallbackClient(fake_api.origin, CALLBACK_SECRET, backoff_s=0.001) as client:
        ack = await client.complete(JOB_ID, ATTEMPT_ID, JobCompletion(status="succeeded"))

    assert ack.applied is True
    assert len(fake_api.completions()) == 3
    for call in fake_api.completions():
        assert call.signature_matches(CALLBACK_SECRET)


async def test_giving_up_raises_after_the_attempt_budget(fake_api: FakeApi) -> None:
    fake_api.responses = [500, 500, 500, 500]
    async with CallbackClient(
        fake_api.origin, CALLBACK_SECRET, max_attempts=2, backoff_s=0.001
    ) as client:
        with pytest.raises(CallbackError, match="after 2 attempts"):
            await client.complete(JOB_ID, ATTEMPT_ID, JobCompletion(status="succeeded"))
    assert len(fake_api.completions()) == 2


async def test_a_transport_failure_is_retried_then_raised() -> None:
    attempts = 0

    async def handler(request: httpx2.Request) -> httpx2.Response:
        nonlocal attempts
        attempts += 1
        raise httpx2.ConnectError("connection refused", request=request)

    transport = httpx2.MockTransport(handler)
    async with httpx2.AsyncClient(transport=transport) as http:
        client = CallbackClient(
            "http://api.invalid", CALLBACK_SECRET, client=http, max_attempts=3, backoff_s=0.001
        )
        with pytest.raises(CallbackError, match="after 3 attempts"):
            await client.progress(JOB_ID, ATTEMPT_ID, 10)
    assert attempts == 3


async def test_a_body_that_is_not_json_still_yields_an_ack() -> None:
    async def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=b"OK")

    async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as http:
        client = CallbackClient("http://api.invalid", CALLBACK_SECRET, client=http)
        ack = await client.progress(JOB_ID, ATTEMPT_ID, 10)
    assert ack.applied is True


async def test_progress_is_clamped_to_the_contract_range(fake_api: FakeApi) -> None:
    async with CallbackClient(fake_api.origin, CALLBACK_SECRET) as client:
        await client.progress(JOB_ID, ATTEMPT_ID, 140.0)
        await client.progress(JOB_ID, ATTEMPT_ID, -20.0)
    assert [call.json["progress"] for call in fake_api.progresses()] == [100.0, 0.0]


def test_a_client_without_a_secret_is_refused() -> None:
    with pytest.raises(ValueError, match="INTERNAL_CALLBACK_SECRET"):
        CallbackClient("http://api.invalid", "")


def test_usage_omits_every_unset_field() -> None:
    assert JobUsage().to_wire() == {}
    assert JobUsage(actual_tenths=12, egress_bytes=99).to_wire() == {
        "actualTenths": 12,
        "egressBytes": 99,
    }


def test_error_message_and_code_are_truncated_to_the_zod_limits() -> None:
    wire = JobError(code="x" * 200, message="y" * 5_000).to_wire()
    assert len(wire["code"]) == 128
    assert len(wire["message"]) == 2_000


def test_a_completion_body_round_trips_as_json() -> None:
    completion = JobCompletion(status="succeeded", result={"chunks": []})
    assert json.loads(encode_body(completion.to_wire())) == {
        "status": "succeeded",
        "result": {"chunks": []},
    }
