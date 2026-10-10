import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AudioPanel } from "./AudioPanel";
import { AudioPanel as AudioPanelReExport } from "../audio-panel";

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

function baseResult(
  overrides: Partial<UseAudioCleanModule.UseAudioCleanResult> = {},
): UseAudioCleanModule.UseAudioCleanResult {
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
    expect(screen.getByTestId("audio-tier-deep-copy")).toHaveTextContent("coming to cloud renders");
  });

  it("enables Deep clean once deepCleanEnabled is true", () => {
    useAudioCleanMock.mockReturnValue(baseResult());
    render(<AudioPanel projectId="p1" onSetAudio={vi.fn()} deepCleanEnabled />);

    expect(screen.getByTestId("audio-tier-deep")).not.toBeDisabled();
    expect(screen.queryByTestId("audio-tier-deep-copy")).not.toBeInTheDocument();
  });

  it("brief C04b §3: greys 'Clean audio' and shows the upload-to-cloud notice for a local project", () => {
    useAudioCleanMock.mockReturnValue(baseResult());
    const onUploadToCloud = vi.fn();
    render(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        isLocalProject
        onUploadToCloud={onUploadToCloud}
      />,
    );

    expect(screen.getByTestId("local-mode-notice")).toHaveTextContent(
      "upload to cloud to use audio clean",
    );
    expect(screen.getByRole("button", { name: /clean audio/i })).toBeDisabled();
  });

  it("emits a SetAudio op with the clean's cleanId when 'Apply to export' is switched on", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult({ cleans: [succeeded] }));
    const onSetAudio = vi.fn();
    render(<AudioPanel projectId="p1" onSetAudio={onSetAudio} />);

    await user.click(screen.getByRole("switch", { name: /apply to export/i }));
    expect(onSetAudio).toHaveBeenCalledWith({
      clean: { enabled: true, cleanId: succeeded.id, targetLufs: -16 },
    });
  });

  it("emits a clearing op with cleanId: null when switched back off", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult({ cleans: [succeeded] }));
    const onSetAudio = vi.fn();
    render(<AudioPanel projectId="p1" onSetAudio={onSetAudio} appliedCleanId={succeeded.id} />);

    await user.click(screen.getByRole("switch", { name: /apply to export/i }));
    expect(onSetAudio).toHaveBeenCalledWith({
      clean: { enabled: false, cleanId: null, targetLufs: 0 },
    });
  });

  it("renders Studio Sound switch and toggles onStudioSoundChange callback", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult());
    const onStudioSoundChange = vi.fn();

    render(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        onStudioSoundChange={onStudioSoundChange}
      />,
    );

    const switchEl = screen.getByTestId("studio-sound-switch");
    expect(switchEl).toBeInTheDocument();
    expect(switchEl).toHaveAttribute("aria-checked", "false");

    await user.click(switchEl);
    expect(onStudioSoundChange).toHaveBeenCalledWith(true);
    expect(switchEl).toHaveAttribute("aria-checked", "true");
  });

  it("switches preview player audio source from audioWavUri to audioCleanUri when Studio Sound is toggled", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult());

    const { rerender } = render(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        audioWavUri="https://example.test/raw_audio.wav"
        audioCleanUri="https://example.test/studio_audio_clean.wav"
      />,
    );

    const player = screen.getByTestId("ab-preview-player");
    expect(player).toHaveAttribute("src", "https://example.test/raw_audio.wav");

    const switchEl = screen.getByTestId("studio-sound-switch");
    await user.click(switchEl);

    expect(player).toHaveAttribute("src", "https://example.test/studio_audio_clean.wav");

    // Also supports controlled studioSound prop
    rerender(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        audioWavUri="https://example.test/raw_audio.wav"
        audioCleanUri="https://example.test/studio_audio_clean.wav"
        studioSound={false}
      />,
    );
    expect(player).toHaveAttribute("src", "https://example.test/raw_audio.wav");

    rerender(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        audioWavUri="https://example.test/raw_audio.wav"
        audioCleanUri="https://example.test/studio_audio_clean.wav"
        studioSound={true}
      />,
    );
    expect(player).toHaveAttribute("src", "https://example.test/studio_audio_clean.wav");
  });

  it("renders Smart Auto-Ducking switch and toggles onAutoDuckingChange callback", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult());
    const onAutoDuckingChange = vi.fn();
    const onSetAudio = vi.fn();

    render(
      <AudioPanel
        projectId="p1"
        onSetAudio={onSetAudio}
        onAutoDuckingChange={onAutoDuckingChange}
      />,
    );

    const duckingSwitch = screen.getByTestId("auto-ducking-switch");
    expect(duckingSwitch).toBeInTheDocument();
    expect(duckingSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("ducking-intensity-controls")).toBeInTheDocument();

    await user.click(duckingSwitch);
    expect(onAutoDuckingChange).toHaveBeenCalledWith(false);
    expect(duckingSwitch).toHaveAttribute("aria-checked", "false");
    expect(onSetAudio).toHaveBeenCalledWith({
      ducking: { enabled: false, duckDb: -16 },
    });
    expect(screen.queryByTestId("ducking-intensity-controls")).not.toBeInTheDocument();
  });

  it("adjusts ducking intensity between subtle, standard, and heavy", async () => {
    const user = userEvent.setup();
    useAudioCleanMock.mockReturnValue(baseResult());
    const onDuckingIntensityChange = vi.fn();
    const onSetAudio = vi.fn();

    render(
      <AudioPanel
        projectId="p1"
        onSetAudio={onSetAudio}
        onDuckingIntensityChange={onDuckingIntensityChange}
      />,
    );

    const subtleBtn = screen.getByTestId("ducking-intensity-subtle");
    const standardBtn = screen.getByTestId("ducking-intensity-standard");
    const heavyBtn = screen.getByTestId("ducking-intensity-heavy");

    expect(standardBtn).toHaveAttribute("aria-checked", "true");
    expect(subtleBtn).toHaveAttribute("aria-checked", "false");
    expect(heavyBtn).toHaveAttribute("aria-checked", "false");

    await user.click(subtleBtn);
    expect(onDuckingIntensityChange).toHaveBeenCalledWith(-12);
    expect(onSetAudio).toHaveBeenCalledWith({
      ducking: { enabled: true, duckDb: -12 },
    });
    expect(subtleBtn).toHaveAttribute("aria-checked", "true");

    await user.click(heavyBtn);
    expect(onDuckingIntensityChange).toHaveBeenCalledWith(-20);
    expect(onSetAudio).toHaveBeenCalledWith({
      ducking: { enabled: true, duckDb: -20 },
    });
    expect(heavyBtn).toHaveAttribute("aria-checked", "true");
  });

  it("supports controlled autoDucking and duckingIntensityDb props", () => {
    useAudioCleanMock.mockReturnValue(baseResult());

    const { rerender } = render(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        autoDucking={false}
      />,
    );

    const duckingSwitch = screen.getByTestId("auto-ducking-switch");
    expect(duckingSwitch).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("ducking-intensity-controls")).not.toBeInTheDocument();

    rerender(
      <AudioPanel
        projectId="p1"
        onSetAudio={vi.fn()}
        autoDucking={true}
        duckingIntensityDb={-20}
      />,
    );

    expect(duckingSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("ducking-intensity-controls")).toBeInTheDocument();
    expect(screen.getByTestId("ducking-intensity-heavy")).toHaveAttribute("aria-checked", "true");
  });

  it("confirms audio-panel.tsx re-export functions identically", () => {
    expect(AudioPanelReExport).toBe(AudioPanel);
  });
});
