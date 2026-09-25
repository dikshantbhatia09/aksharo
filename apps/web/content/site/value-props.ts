/**
 * The eight value propositions, in the order 02-product-vision.md states them
 * ("Value propositions (in the order we will say them)"). The home hero
 * condenses these to three lines (`hero-copy.ts`); the Features page gives each
 * one its own section, per the brief.
 */

export interface ValueProp {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export const VALUE_PROPS: readonly ValueProp[] = [
  {
    id: "accuracy",
    title: "Measured accuracy on how India speaks",
    body: "We publish our code-mixed (Hinglish) word error rate and per-language numbers on a named eval set — no competitor does. Hindi, 21 other Indian languages and 90+ global languages are each routed to the model that scores best for that language (Sarvam, ElevenLabs Scribe, self-hosted Whisper).",
  },
  {
    id: "editable",
    title: "Every word is editable and force-aligned",
    body: "Drag a word, split a line, recolour, emphasise, retime — three scripts from one take (Roman, native script, and a translated script), all keeping the same timing.",
  },
  {
    id: "styles",
    title: "A bold caption style, every word tunable",
    body: "Designed for Reels, Shorts and YouTube, exported at up to 4K, browser-native with zero upload when you want privacy. Save your own look as a template.",
  },
  {
    id: "editing",
    title: "It edits, not just captions",
    body: "Autocut (silence, fillers, retakes) and zoom/reframe that follows the subject, with customizable text styling. Every change is a reviewable proposal you accept or reject — never a silent mutation.",
  },
  {
    id: "timeline",
    title: "Timeline exports and integrations",
    body: "Export industry-standard SRT, VTT and ASS subtitles directly into your video workflow. Native panel integrations for Premiere Pro, After Effects and DaVinci Resolve are not available yet.",
  },
  {
    id: "one-plan",
    title: "One transparent credit pool",
    body: "Your web studio runs on one clear credit balance with no hidden caps. Start free, and scale with seats for editors working across a team.",
  },
  {
    id: "pricing",
    title: "Priced for India, ready for the world",
    body: "₹ with UPI Autopay, a free clean export on signup, a ₹9 clean export, a ₹59 week pass, ₹149 top-ups. USD by card everywhere else.",
  },
  {
    id: "privacy",
    title: "Your footage is yours",
    body: "Browser exports render locally via WebCodecs with zero video upload when you choose in-browser export; cloud media is deleted on a published schedule. No training on your content by us or by the providers we route to — only providers with signed no-training, zero-retention terms are used in production. We remember your spellings and preferences only if you switch that on, and you can view, edit or clear them any time.",
  },
];

/** The condensed three-line hero copy lives in `hero-copy.ts` (`HeroCopy.subheads`). */
