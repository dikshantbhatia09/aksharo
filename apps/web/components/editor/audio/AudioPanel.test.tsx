import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AudioPanel } from "./AudioPanel";

import type { AudioClean } from "./audio-endpoints";
import type * as UseAudioCleanModule from "./use-audio-clean";

const succeeded: AudioClean = {
  id: "01JBQ8Z2W4N7Y0K3M5P8R1T6VE",
  projectId: "p1",
  mediaId: "m1",
  strength: "medium",
  target: "social",
  dereverb: false,
  deesser: false,
  status: "succeeded",
  metrics: { inputLufs: -12, outputLufs: -16, snrGainDb: 8 },
  previewOriginalUrl: "https://example.test/original.mp3",
  previewCleanedUrl: "https://example.test/cleaned.mp3",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const useAudioCleanMock = vi.fn<(projectId: string) => UseAudioCleanModule.UseAudioCleanResult>();

vi.mock("./use-audio-clean", async () => {
  const actual = await vi.importActual<typeof UseAudioCleanModule>("./use-audio-clean");
  return {
    ...actual,
    useAudioClean: (projectId: string) => useAudioCleanMock(projectId),
  };
});

function baseResult(overrides: Partial<UseAudioCleanModule.UseAudioCleanResult> = {}): UseAudioCleanModule.UseAudioCleanResult {
  return {
    cleans: [],
    loading: false,
    error: undefined,
    starting: false,
    start: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("<AudioPanel />", () => {
  it("greys out Deep clean with 'coming to cloud renders' copy until AUDIO_DEEP_CLEAN_ENABLED (D82)", () => {
    useAudioCleanMock.mockReturnValue(baseResult());
    render(<AudioPanel projectId="p1" onSetAudio={vi.fn()} />);

    const deep = screen.getByTestId("audio-tier-deep");
    expect(deep).toBeDisabled();
    expect(screen.getByTestId("audio-tier-deep-copy")).toHaveTextContent(
      "coming to cloud renders",
    );
  });

  it("enables Deep clean once deepCleanEnabled is true", () => {
    useAudioCleanMock.mockReturnValue(baseResult());
    render(<AudioPanel projectId="p1" onSetAudio={vi.fn()} deepCleanEnabled />);

    expect(screen.getByTestId("audio-tier-deep")).not.toBeDisabled();
    expect(screen.queryByTestId("audio-tier-deep-copy")).not.toBeInTheDocument();
  });

  it("emits a SetAudio op with the clean's cleanId when 'Apply to export' is switched on", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult({ cleans: [succeeded] }));
    const onSetAudio = vi.fn();
    render(<AudioPanel projectId="p1" onSetAudio={onSetAudio} />);

    await user.click(screen.getByRole("switch"));
    expect(onSetAudio).toHaveBeenCalledWith({
      clean: { enabled: true, cleanId: succeeded.id, targetLufs: -16 },
    });
  });

  it("emits a clearing op with cleanId: null when switched back off", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult({ cleans: [succeeded] }));
    const onSetAudio = vi.fn();
    render(<AudioPanel projectId="p1" onSetAudio={onSetAudio} appliedCleanId={succeeded.id} />);

    await user.click(screen.getByRole("switch"));
    expect(onSetAudio).toHaveBeenCalledWith({
      clean: { enabled: false, cleanId: null, targetLufs: 0 },
    });
  });
});
