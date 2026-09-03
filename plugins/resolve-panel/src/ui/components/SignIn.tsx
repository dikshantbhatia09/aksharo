import { t } from "../../i18n/strings.js";
import { TEXT } from "../tokens.js";

import type { SessionStatus } from "../../auth/session.js";
import type { JSX } from "react";

export interface SignInProps {
  readonly status: SessionStatus;
  readonly onOpenVerificationUrl: (url: string) => void;
}

/** Sign-in state mirrored from the script's own device-code flow (brief item 1). This panel
 * never runs the flow itself — see `src/auth/session.ts`'s header comment. */
export function SignIn({ status, onOpenVerificationUrl }: SignInProps): JSX.Element {
  const { pairing } = status;
  if (pairing) {
    return (
      <div data-testid="sign-in-pairing" style={{ padding: 16, color: TEXT.fg0 }}>
        <p style={{ fontSize: 12 }}>{t("signIn.waiting")}</p>
        <p style={{ fontSize: 12, color: TEXT.fg1 }}>{t("signIn.codeLabel")}</p>
        <button
          type="button"
          data-testid="sign-in-open-url"
          onClick={() => onOpenVerificationUrl(pairing.verificationUrl)}
        >
          {pairing.userCode}
        </button>
      </div>
    );
  }
  return (
    <div data-testid="sign-in-waiting" style={{ padding: 16, color: TEXT.fg1, fontSize: 12 }}>
      {t("signIn.title")}…
    </div>
  );
}
