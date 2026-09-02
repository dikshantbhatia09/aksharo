/**
 * Pricing FAQ (A24 brief: "FAQ answering Pause's objections plus ours").
 *
 * The first block answers the exact questions Pause's own FAQ accordion asks
 * (03-architecture/01-competitive-analysis.md §3 — "Pause's FAQ questions are
 * exactly the objections we must answer on our pricing page", §5), in our own
 * words and against our own decided facts. The second block covers the India
 * payments objections 04-pricing-and-monetization.md calls out by name:
 * privacy, mandates, refunds, GST-inclusive display and the ₹15,000 UPI rule.
 */

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

export const PAUSE_OBJECTIONS: readonly FaqEntry[] = [
  {
    question: "How accurate are the captions?",
    answer:
      "We publish our own code-mixed (Hinglish) and per-language word error rate on a named public eval set — the one number no competitor in this space publishes. The figures land on the Features page once the eval run completes (target: Hinglish WER ≤ 12%, English WER ≤ 8%, Indic alignment error ≤ 80 ms). Hindi, 21 other Indian languages and 90+ global languages are each routed to the model that scores best for that language.",
  },
  {
    question: "Does my footage ever leave my computer?",
    answer:
      "Only if you ask it to. Desktop local mode never uploads. Browser export renders in your own browser with WebCodecs — zero upload. Plugins upload audio only, unless you explicitly request a video-dependent pass. Cloud media is deleted on a published retention schedule, and nothing you send us — locally or to the cloud — trains a model, ours or a provider's; we only route to providers with signed no-training, zero-retention terms.",
  },
  {
    question: "How long does processing take?",
    answer:
      "Target: p50 under 60 seconds for a 5-minute clip, cloud or local on recent hardware. You will see live stage progress — uploading, transcribing, aligning, ready — never a spinner with no explanation.",
  },
  {
    question: "Can I tweak the edit afterward?",
    answer:
      "Every word is editable and force-aligned: drag a word, split a line, recolour, retime. Every autocut, zoom, SFX or music decision is a reviewable proposal with a confidence score — accept, reject or edit it individually, or bulk-accept above a confidence threshold. Nothing an AI pass does is a silent, unreviewable mutation.",
  },
  {
    question: "Will it touch my original footage?",
    answer:
      "No. Passes write proposals to your project's edit graph; your source media is never modified in place, and every accepted change stays undoable.",
  },
  {
    question: "Does this replace my editor?",
    answer:
      "No — it removes the busywork so the humanness stays. Transcribing, caption styling, silence and filler removal, and first-pass zooms are exactly the hours an editor does not need to spend by hand; taste, pacing and story are still a person's call, made faster because the setup work is already done.",
  },
  {
    question: "What will it actually cost me?",
    answer:
      "One credit pool for web, desktop and every plugin — no per-plugin subscription, no per-video length cap on a paid plan. Start free with one clean export on us, or try a single ₹9 export or a ₹59 week pass before committing to a monthly plan. See the credits-to-outcomes table above for what a plan's monthly allowance actually gets you.",
  },
];

export const OUR_OBJECTIONS: readonly FaqEntry[] = [
  {
    question: "What exactly do you do with my data?",
    answer:
      'Your account, workspace, media, transcripts and edits run the product and are kept while your account exists. Product analytics and "remember my spellings and preferences" are both off by default and require an explicit opt-in; either can be viewed, edited or cleared at any time. We never train AI models — ours or a provider\'s — on your content. Full detail is in the privacy notice.',
  },
  {
    question: 'What is a "mandate" and can I cancel it?',
    answer:
      "A UPI Autopay or card mandate is registered as a variable amount capped at the undiscounted list price of your plan — it can only ever charge that price or less, never more, even after a streak discount. You can view and cancel any mandate in-product at any time; cancelling stops future renewals and you keep access until the current period ends.",
  },
  {
    question: "What if I want a refund?",
    answer:
      "Monthly plans: cancel any time, access continues until the period ends; a 7-day money-back window applies to your first monthly purchase if you used fewer than 20 credits. Yearly plans: a 14-day refund window, pro-rated by usage. A failed job's credit hold is released automatically — no refund request needed. Every money refund issues a GST credit note.",
  },
  {
    question: 'Why does the price say "incl. GST"?',
    answer:
      "Every price shown to an Indian customer already includes 18% GST — what you see is what you pay, and the tax break-up is itemised on your receipt (s.33 CGST / Rule 35). We ask for your billing State on your first purchase because Indian GST law requires it to fix the place of supply; GSTIN is optional and, when given, auto-fills your State.",
  },
  {
    question: "Why does Studio yearly bill in two payments instead of one?",
    answer:
      "RBI rules do not allow an auto-renewing UPI mandate above ₹15,000, and Studio's yearly price (₹19,992) sits above that line. So Studio yearly over UPI Autopay is two half-yearly debits of ₹9,996 each — everything else about the yearly discount is unchanged. If you would rather not split it, a single card or eNACH charge, or a pay-once purchase with a renewal reminder, both work for the full amount. Creator yearly (₹6,984) and Agency yearly per seat (₹11,988) both fit comfortably under the cap as a single UPI mandate.",
  },
];
