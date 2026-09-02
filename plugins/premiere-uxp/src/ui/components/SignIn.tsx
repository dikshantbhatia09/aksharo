import { useState } from "react";

import { t } from "../../i18n/strings.js";
import { ACCENT, TEXT } from "../tokens.js";

import type { SignInState } from "../../auth/session.js";
import type { JSX } from "react";

export interface SignInProps {
  readonly state: SignInState;
  readonly onBeginSignIn: () => void;
  readonly onConfirm: (code?: string) => void;
  readonly onSignOut: () => void;
}

/** Sign-in panel: device-code style pairing with an 8-char code fallback (brief item 2). */
export function SignIn({ state, onBeginSignIn, onConfirm, onSignOut }: SignInProps): JSX.Element {
  const [codeInput, setCodeInput] = useState("");

  if (state.status === "signedIn") {
    return (
      <div data-testid="sign-in-signed-in">
        <button type="button" onClick={onSignOut}>
          {t("signIn.signOut")}
        </button>
      </div>
    );
  }

  if (state.status === "awaitingApproval") {
    return (
      <div data-testid="sign-in-awaiting">
        <p>{t("signIn.waiting")}</p>
        <button type="button" onClick={() => onConfirm()}>
          {t("signIn.approve")}
        </button>
        {state.code && (
          <div>
            <label htmlFor="pair-code">{t("signIn.codeLabel")}</label>
            <div style={{ fontFamily: "monospace", fontSize: 18, color: ACCENT.lime500 }}>
              {state.code}
            </div>
            <input
              id="pair-code"
              aria-label={t("signIn.codeInputLabel")}
              value={codeInput}
              onChange={(event) => setCodeInput(event.target.value)}
              maxLength={8}
            />
            <button type="button" onClick={() => onConfirm(codeInput)}>
              {t("signIn.approve")}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div data-testid="sign-in-error" style={{ color: TEXT.fg0 }}>
        <p role="alert">{t("signIn.error", { message: state.message })}</p>
        <button type="button" onClick={onBeginSignIn}>
          {t("signIn.cta")}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="sign-in-signed-out">
      <button type="button" onClick={onBeginSignIn} disabled={state.status === "requesting"}>
        {t("signIn.cta")}
      </button>
    </div>
  );
}
