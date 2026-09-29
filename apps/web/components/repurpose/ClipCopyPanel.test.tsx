import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RepurposeCandidateItem, RepurposeClipCopy } from "@montaj/api-client";

import { CandidateCard } from "./CandidateCard";
import { CLIP_COPY_COPY, ClipCopyPanel, copyFields } from "./ClipCopyPanel";
import { COPY_TEXT_COPY, copyText } from "./copy-text";

import { renderWithProviders } from "@/test/harness";

const CAND = "01JS000000000000000000CAND";
const RUN = "01JS0000000000000000000RUN";

const COPY: RepurposeClipCopy = {
  summary: "Salary badhne par bhi paise kyun nahi bachte, yeh clip batata hai.",
  hook: "Yeh galti sab karte hain",
  cta: "Poora episode dekhiye",
  hashtags: ["#money", "#paisa", "#savingtips"],
  locale: "hi-Latn",
  title: "Salary se ameer kyun nahi bante?",
  description: "Is clip mein savings ki sabse badi galti ki baat hai.",
  platforms: {
    youtube: { title: "Salary se ameer kyun nahi bante?", description: "Savings ki galti. #money" },
    instagram: { caption: "Yeh galti sab karte hain!\n\n#money #paisa" },
    tiktok: { caption: "Salary ki sabse badi galti #money" },
    linkedin: { text: "Salary badhna kaafi nahi hai. Aap kya sochte hain?" },
    x: { text: "Salary se ameer kyun nahi bante? #money" },
    facebook: { text: "Is clip mein savings ki baat hai.\n\nPoora episode dekhiye" },
  },
  source: "model",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
}

describe("<ClipCopyPanel />", () => {
  it("is folded away under the clip until opened, and says who wrote it", () => {
    render(<ClipCopyPanel candidateId={CAND} title={COPY.title ?? ""} copy={COPY} />);

    const panel = screen.getByTestId(`clip-copy-${CAND}`);
    expect(panel.tagName).toBe("DETAILS");
    expect(panel).not.toHaveAttribute("open");
    expect(panel).toHaveTextContent(CLIP_COPY_COPY.summary);
    expect(panel).toHaveTextContent(CLIP_COPY_COPY.byModel);
  });

  it("lists the title, hook, description, hashtags and every platform's text", () => {
    render(<ClipCopyPanel candidateId={CAND} title={COPY.title ?? ""} copy={COPY} />);

    const field = (id: string) => screen.getByTestId(`clip-copy-field-${CAND}-${id}`);
    expect(field("title")).toHaveTextContent("Salary se ameer kyun nahi bante?");
    expect(field("hook")).toHaveTextContent("Yeh galti sab karte hain");
    expect(field("description")).toHaveTextContent("sabse badi galti");
    expect(field("hashtags")).toHaveTextContent("#money #paisa #savingtips");
    for (const id of [
      "youtube-title",
      "youtube-description",
      "instagram",
      "tiktok",
      "linkedin",
      "x",
      "facebook",
    ]) {
      expect(field(id)).toBeInTheDocument();
    }
    // X's limit is shown against the post.
    expect(field("x")).toHaveTextContent(`${String(COPY.platforms?.x?.text.length)}/280`);
    // Each has its own Copy button, named for what it copies.
    expect(
      within(field("hook")).getByRole("button", {
        name: `Copy on-screen hook: ${COPY.title ?? ""}`,
      }),
    ).toBeInTheDocument();
  });

  it("says when the words were taken from the clip rather than written by the model", () => {
    render(<ClipCopyPanel candidateId={CAND} title="t" copy={{ ...COPY, source: "heuristic" }} />);
    expect(screen.getByTestId(`clip-copy-${CAND}`)).toHaveTextContent(CLIP_COPY_COPY.byRule);
  });

  it("leaves out what is empty, and shows nothing for a copy with nothing in it", () => {
    const bare: RepurposeClipCopy = { summary: "", hook: "", cta: "", hashtags: [], locale: "en" };
    const { container } = render(<ClipCopyPanel candidateId={CAND} title="t" copy={bare} />);
    expect(container).toBeEmptyDOMElement();
    expect(copyFields({ ...bare, hook: "A hook" }).main.map((field) => field.id)).toEqual(["hook"]);
  });

  it("copies a field to the clipboard and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    render(<ClipCopyPanel candidateId={CAND} title={COPY.title ?? ""} copy={COPY} />);

    const button = screen.getByTestId(`copy-${CAND}-hashtags`);
    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeText).toHaveBeenCalledWith("#money #paisa #savingtips");
    await waitFor(() => {
      expect(button).toHaveTextContent(COPY_TEXT_COPY.copied);
    });
  });
});

describe("copyText", () => {
  it("falls back to select-and-copy when the Clipboard API is refused", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    await expect(copyText("hello")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither way works", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => false),
      configurable: true,
    });
    await expect(copyText("hello")).resolves.toBe(false);
  });
});

describe("<CandidateCard /> with copy", () => {
  function candidate(extra: Partial<RepurposeCandidateItem> = {}): RepurposeCandidateItem {
    return {
      id: CAND,
      startMs: 60_000,
      endMs: 90_000,
      title: "yeh sabse badi galti hai jo log",
      potentialScore: 71,
      transcriptExcerpt: "yeh sabse badi galti hai jo log salary ke saath karte hain",
      ...extra,
    };
  }

  it("is titled by its copy and offers the words to post under it", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate({ copy: COPY })}
          clip={undefined}
          previewActive={false}
          onActivatePreview={() => undefined}
        />
      </ul>,
    );

    const card = screen.getByTestId(`candidate-card-${CAND}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Salary se ameer kyun nahi bante?",
    );
    expect(within(card).getByTestId(`clip-copy-${CAND}`)).toBeInTheDocument();
  });

  it("keeps its own title, and no panel, when it has no copy", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate({ copy: {} })}
          clip={undefined}
          previewActive={false}
          onActivatePreview={() => undefined}
        />
      </ul>,
    );

    const card = screen.getByTestId(`candidate-card-${CAND}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "yeh sabse badi galti hai jo log",
    );
    expect(within(card).queryByTestId(`clip-copy-${CAND}`)).not.toBeInTheDocument();
  });

  it("prefers the clip's own copy, once it has one, over its moment's", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate({ copy: COPY })}
          clip={{
            id: "01CLIP",
            candidateId: CAND,
            state: "cutting",
            copy: { ...COPY, title: "Edited title", source: "person" },
          }}
          previewActive={false}
          onActivatePreview={() => undefined}
        />
      </ul>,
    );
    const card = screen.getByTestId(`candidate-card-${CAND}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent("Edited title");
    expect(within(card).getByTestId(`clip-copy-${CAND}`)).toHaveTextContent(
      CLIP_COPY_COPY.byPerson,
    );
  });
});
