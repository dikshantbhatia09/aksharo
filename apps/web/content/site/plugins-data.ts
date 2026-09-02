/**
 * Plugins page data (D65 — plugin naming and Adobe/Blackmagic rules;
 * 08-ux-design-system.md §Plugins page).
 *
 * Product names are exactly the strings CONTRACTS §0 and D65 require:
 * "Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects" and
 * "Aksharo — works with DaVinci Resolve". Never "Premiere plugin" or
 * "Resolve plugin" alone, and never a montaj string.
 */

export interface HostSurface {
  readonly id: string;
  readonly productName: string;
  readonly hosts: readonly string[];
  readonly summary: string;
  readonly capabilityNotes: readonly string[];
  readonly minimumHostVersion: string;
  readonly installNote: string;
}

export const HOST_SURFACES: readonly HostSurface[] = [
  {
    id: "premiere-ae",
    productName: "Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects",
    hosts: ["Adobe Premiere Pro", "Adobe After Effects"],
    summary:
      "Injects the Hinglish transcript into Premiere's own Text-Based Editing panel, applies MOGRT captions or alpha overlays, and lands cuts, zooms and audio as real timeline items in one undo step. After Effects gets styled text layers and overlays from the same transcript.",
    capabilityNotes: [
      "Native Premiere captions-track writing: waiting on Adobe to ship the UXP caption API. We inject the transcript and apply MOGRT captions or alpha overlays until then.",
      'The panel cannot launch an external application (a UXP restriction) — "Open in Aksharo" opens an https link; the desktop app handles the deep link from there.',
    ],
    minimumHostVersion: "Premiere Pro / After Effects 25.2+",
    installNote: "`.ccx` direct download, or the Adobe Marketplace listing.",
  },
  {
    id: "resolve",
    productName: "Aksharo — works with DaVinci Resolve",
    hosts: ["DaVinci Resolve"],
    summary:
      "One script core for Resolve Free and Studio: native Text+ captions, cuts and dynamic zooms. Resolve's own auto-captions have no Indic language support at all.",
    capabilityNotes: [
      "Undo: not supported by Resolve's own scripting API for actions this integration makes — undo inside Resolve's native timeline tools instead.",
      "Native Text+ captions on Resolve Free and Studio, Windows, macOS and Linux.",
    ],
    minimumHostVersion: "DaVinci Resolve 18.6+",
    installNote: "Script installer, Windows / macOS / Linux.",
  },
];

export interface ActivationStep {
  readonly step: number;
  readonly title: string;
  readonly body: string;
}

export const ACTIVATION_STEPS: readonly ActivationStep[] = [
  {
    step: 1,
    title: "Install",
    body: "Premiere Pro: the .ccx direct download, or the Adobe Marketplace listing. After Effects: the installer or a .zxp. DaVinci Resolve: the script installer for Free and Studio, on Windows, macOS or Linux.",
  },
  {
    step: 2,
    title: "Connect",
    body: "Open the panel and choose Sign in — approve the short code shown there on this page. On a locked-down machine without a browser, generate a licence key instead; it works offline for 7 days between check-ins.",
  },
  {
    step: 3,
    title: "Caption your timeline",
    body: "Premiere: your transcript appears directly in Premiere's own Text-Based Editing panel. DaVinci Resolve: captions land as native, editable Text+ clips on your timeline.",
  },
];

export const ATTRIBUTION_LINE =
  "Adobe, Premiere Pro and After Effects are trademarks of Adobe Inc.; DaVinci Resolve is a trademark of Blackmagic Design. Aksharo is not affiliated with or endorsed by Adobe or Blackmagic Design.";
