"""Sign-in/session state mirrored by the C09 Studio panel from this script's
own bridge device-code flow (B08b, `bridge/device_auth.py`).

The panel has no Resolve API of its own (brief: "the panel talks only to
C08's in-Resolve loopback server"), so it cannot run the device-code flow
itself; instead this script owns one `SessionState` and exposes it read-only
over `session.status` (`server.py`'s `PanelDeps`). The script updates the
state as `device_auth.bootstrap_device_credentials`'s callbacks fire
(pairing code shown, then signed in) — that wiring is not part of this
module, which only holds the state and its wire shape.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class SessionState:
    signed_in: bool = False
    workspace_id: str | None = None
    user_email: str | None = None
    pairing_user_code: str | None = None
    pairing_verification_url: str | None = None

    def to_wire(self) -> dict[str, object]:
        return {
            "signedIn": self.signed_in,
            "workspaceId": self.workspace_id,
            "userEmail": self.user_email,
            "pairing": (
                {
                    "userCode": self.pairing_user_code,
                    "verificationUrl": self.pairing_verification_url,
                }
                if self.pairing_user_code is not None
                else None
            ),
        }

    def mark_pairing(self, user_code: str, verification_url: str) -> None:
        """A device code was issued and is awaiting approval in the system
        browser (`device_auth.PairingCodeInfo`)."""
        self.pairing_user_code = user_code
        self.pairing_verification_url = verification_url

    def mark_signed_in(self, workspace_id: str, user_email: str) -> None:
        self.signed_in = True
        self.workspace_id = workspace_id
        self.user_email = user_email
        self.pairing_user_code = None
        self.pairing_verification_url = None

    def mark_signed_out(self) -> None:
        self.signed_in = False
        self.workspace_id = None
        self.user_email = None
        self.pairing_user_code = None
        self.pairing_verification_url = None


__all__ = ["SessionState"]
