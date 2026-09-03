import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SignIn } from "./SignIn.js";
import { SIGNED_OUT_STATUS } from "../../auth/session.js";

describe("SignIn", () => {
  it("shows a waiting state with no pairing yet", () => {
    render(<SignIn status={SIGNED_OUT_STATUS} onOpenVerificationUrl={() => {}} />);
    expect(screen.getByTestId("sign-in-waiting")).toBeInTheDocument();
  });

  it("shows the pairing code and opens the verification URL", async () => {
    const onOpen = vi.fn();
    render(
      <SignIn
        status={{
          signedIn: false,
          workspaceId: null,
          userEmail: null,
          pairing: { userCode: "4F7K-92QA", verificationUrl: "https://aksharo.ai/device" },
        }}
        onOpenVerificationUrl={onOpen}
      />,
    );
    expect(screen.getByTestId("sign-in-open-url").textContent).toBe("4F7K-92QA");
    await userEvent.click(screen.getByTestId("sign-in-open-url"));
    expect(onOpen).toHaveBeenCalledWith("https://aksharo.ai/device");
  });
});
