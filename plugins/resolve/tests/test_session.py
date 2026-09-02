from __future__ import annotations

from aksharo_core_app.session import SessionState


def test_default_state_is_signed_out() -> None:
    state = SessionState()
    assert state.to_wire() == {
        "signedIn": False,
        "workspaceId": None,
        "userEmail": None,
        "pairing": None,
    }


def test_mark_pairing_reports_the_code() -> None:
    state = SessionState()
    state.mark_pairing("4F7K-92QA", "https://aksharo.ai/device")
    wire = state.to_wire()
    assert wire["signedIn"] is False
    assert wire["pairing"] == {
        "userCode": "4F7K-92QA",
        "verificationUrl": "https://aksharo.ai/device",
    }


def test_mark_signed_in_clears_pairing() -> None:
    state = SessionState()
    state.mark_pairing("4F7K-92QA", "https://aksharo.ai/device")
    state.mark_signed_in("ws_1", "creator@example.com")
    assert state.to_wire() == {
        "signedIn": True,
        "workspaceId": "ws_1",
        "userEmail": "creator@example.com",
        "pairing": None,
    }


def test_mark_signed_out_resets_everything() -> None:
    state = SessionState()
    state.mark_signed_in("ws_1", "creator@example.com")
    state.mark_signed_out()
    assert state.to_wire() == {
        "signedIn": False,
        "workspaceId": None,
        "userEmail": None,
        "pairing": None,
    }
