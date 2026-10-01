import type { MessageCatalogue } from "./messages.js";

/**
 * English (India). The copy rules of `08-ux-design-system.md` section 6: short,
 * editor to editor, numbers explicit, and every message says what to do next.
 */
export const EN_MESSAGES: MessageCatalogue = {
  locale: "en-IN",

  chrome: {
    signoff: "Sent by {brand}. Questions? Reply to this message or write to {support}.",
    unsubscribe: "Turn off these emails",
  },

  defaults: {
    name: "there",
    device: "a new device",
    location: "an unrecognised location",
    // `hostApp` is read by a `select`, so its "absent" value has to be a literal
    // the message can branch on rather than an empty string.
    hostApp: "none",
    project: "your project",
    author: "Someone",
    plan: "your plan",
    video: "your video",
    clip: "your clip",
    // "yes" on a workspace's first ever "clips ready" (2026-10-01); read by a `select`.
    first: "no",
  },

  kinds: {
    "verify-email": {
      subject: "Confirm your email address",
      heading: "Confirm your email address",
      paragraphs: ["Hi {name}, one step left. Confirm this address and your account is ready."],
      cta: "Confirm email",
      footnotes: [
        "The link works once and expires in {hours, plural, one {# hour} other {# hours}}.",
        "If you did not create an account, ignore this message — nothing happens without the link.",
      ],
    },

    "magic-link": {
      subject: "Your sign-in link",
      heading: "Sign in to {brand}",
      paragraphs: ["Hi {name}, here is your sign-in link. No password needed."],
      cta: "Sign in",
      footnotes: [
        "The link works once and expires in {minutes, plural, one {# minute} other {# minutes}}.",
        "If you did not ask to sign in, ignore this message and change your password at {support}.",
      ],
    },

    "password-changed": {
      subject: "Your password was changed",
      heading: "Your password was changed",
      paragraphs: [
        "Hi {name}, the password on your account was changed just now. Every other signed-in device has been signed out.",
        "If that was you, there is nothing to do.",
      ],
      cta: "Review your sessions",
      footnotes: [
        "If it was not you, reset your password from the link above and write to {support} straight away.",
      ],
    },

    "device-approval": {
      subject: "Approve {device}",
      heading: "Approve a new device",
      paragraphs: [
        "Hi {name}, {device} is asking to sign in to {brand}{hostApp, select, none {} other { from {hostApp}}}.",
        "Request from {location}. Approve it only if you started it.",
      ],
      cta: "Approve this device",
      footnotes: [
        "The request expires in {minutes, plural, one {# minute} other {# minutes}}.",
        "If this was not you, ignore this message — the device stays locked out.",
      ],
    },

    "login-new-device": {
      subject: "New sign-in from {device}",
      heading: "New sign-in on your account",
      paragraphs: [
        "Hi {name}, your account was signed in on {device} from {location} at {at}.",
        "If that was you, there is nothing to do.",
      ],
      cta: "Review your sessions",
      footnotes: [
        "If it was not you, sign that session out from the link above and change your password.",
      ],
    },

    "parental-waitlist": {
      subject: "You are on the family accounts waitlist",
      heading: "You are on the waitlist",
      paragraphs: [
        "Thanks — we will write to this address the day family accounts open, and not before.",
        "Until then a parent or guardian can use their own account, and nothing has been created for the young person.",
      ],
      footnotes: ["One message, one address. Reply to this email to be taken off the list."],
    },

    "renewal-notice": {
      subject: "{plan} renews on {renewsOn} — {amount}",
      heading: "Your plan renews in {days, plural, one {# day} other {# days}}",
      paragraphs: [
        "Hi {name}, your {plan} plan renews on {renewsOn} and {amount} will be debited from the payment method on file.",
        "You can change or cancel the plan before then; a cancellation takes effect at the end of the current period.",
      ],
      cta: "Manage your plan",
      footnotes: [
        "This is the pre-debit notice your bank requires, so it is sent for every renewal.",
      ],
    },

    "low-credits": {
      subject: "{minutes, plural, one {# minute} other {# minutes}} of processing left",
      heading: "You are running low",
      paragraphs: [
        "Hi {name}, your workspace has {minutes, plural, one {# minute} other {# minutes}} of cloud processing left.",
        "Top up now and nothing in the queue stops halfway.",
      ],
      cta: "Top up",
      footnotes: ["Browser-native exports never use processing minutes."],
    },

    "export-ready": {
      subject: "{project} is ready to download",
      heading: "Your export is ready",
      paragraphs: ["Hi {name}, {project} has finished rendering and is ready to download."],
      cta: "Download",
      footnotes: [
        "The file is kept for {days, plural, one {# day} other {# days}}, then deleted. Re-export any time from the project.",
      ],
    },

    "support-ticket-created": {
      subject: "[{category}] {subject}",
      heading: "New support ticket: {subject}",
      paragraphs: [
        'Workspace {workspaceId} filed a {category} ticket: "{subject}".',
        "Diagnostics: {diagnostics}.",
      ],
      cta: "Open in admin",
      footnotes: ["Ticket id {ticketId}."],
    },

    "share-comment": {
      subject: "{count, plural, one {# new comment} other {# new comments}} on {project}",
      heading: "{count, plural, one {# new comment} other {# new comments}}",
      paragraphs: [
        "Hi {name}, {author} left {count, plural, one {a comment} other {# comments}} on {project}.",
      ],
      cta: "Open the review",
      footnotes: ["Comments are grouped, so a busy review is one message and not twenty."],
    },

    "streak-nudge": {
      subject: "One export from keeping your streak this week",
      heading: "Your streak needs one more export this week",
      paragraphs: [
        "Hi {name}, it is Tuesday and your streak has {days, plural, one {# publish day} other {# publish days}} so far this week — three keeps it.",
        "One export or apply before Sunday keeps L{level} moving.",
      ],
      cta: "Open the app",
      footnotes: [
        "A freeze can cover a missed week automatically, but nothing beats a real export.",
      ],
    },

    "retention-warning": {
      subject: "“{projectTitle}” is deleted in {days, plural, one {# day} other {# days}}",
      heading: "This project is due for deletion",
      paragraphs: [
        "Hi {name}, your plan keeps a project's media for a limited time, and “{projectTitle}” reaches that limit on {retentionUntil}.",
        "Open the project before then to keep it — any activity resets the retention window. After the date, its media is permanently deleted and cannot be recovered.",
      ],
      cta: "Open the project",
      footnotes: ["Upgrading your plan also extends how long projects are kept."],
    },

    "share-report-resolved": {
      subject: "Your report about a shared link has been reviewed",
      heading: "Your report has been reviewed",
      paragraphs: [
        "Hi {name}, thanks for the report you filed on {reportedAt} — an admin has reviewed the shared link and marked it {resolution}.",
        "{resolutionNote}",
      ],
      cta: "Learn about sharing",
      footnotes: ["This message confirms the review only; no further action is needed from you."],
    },

    "support-ticket-reply": {
      subject: "New reply on your ticket: {subject}",
      heading: "You have a reply",
      paragraphs: ["Hi {name}, our support team replied to your ticket:", "{replyBody}"],
      cta: "View your ticket",
      footnotes: ["Ticket id {ticketId}."],
    },

    "clips-ready": {
      subject:
        "{first, select, yes {Your first clips are ready: {video}} other {Your first clips from {video} are ready}}",
      heading: "{first, select, yes {Your first clips are ready} other {Your clips are ready}}",
      paragraphs: [
        "Hi {name}, {count, plural, one {# clip from {video} is} other {# clips from {video} are}} ready to watch.",
        "{first, select, yes {Each one is cut on the speaker, captioned and scored. Open the run to watch them best first: open any one in the editor to change its words or look, download them all in one go, or share them with your guest. Any still being made appear there as they finish.} other {Open the run to watch, edit or download them. Any still being made appear there as they finish.}}",
      ],
      cta: "Open your clips",
      footnotes: ["You get this once for each video."],
      push: {
        title: "{first, select, yes {Your first clips are ready} other {Your clips are ready}}",
        body: "{count, plural, one {# clip} other {# clips}} from {video} ready to watch.",
      },
    },

    "run-complete": {
      subject: "All done: {count, plural, one {# clip} other {# clips}} from {video}",
      heading: "Everything is ready",
      paragraphs: [
        "Hi {name}, we finished {video}: {count, plural, one {# clip} other {# clips}}, with their sizes and images.",
        "Download them from the run, or open any one in the editor to change it.",
      ],
      cta: "Open your clips",
      push: {
        title: "Everything is ready",
        body: "{count, plural, one {# clip} other {# clips}} from {video}, with their sizes and images.",
      },
    },

    "run-failed": {
      subject: "We could not finish {video}",
      heading: "This video stopped",
      paragraphs: [
        "Hi {name}, we could not finish {video}. Anything already made is safe.",
        "Open the run to see what happened and what to try next.",
      ],
      cta: "Open the run",
      push: {
        title: "A video stopped",
        body: "We could not finish {video}. Open it to see why.",
      },
    },

    "run-needs-you": {
      subject:
        "{reason, select, credits {Add credits to finish {video}} upload {Upload the file for {video}} add {{video} is ready for your moments} other {Your moments from {video} are ready}}",
      heading:
        "{reason, select, credits {You are out of credits} upload {YouTube keeps refusing this video} add {Add your moments} other {Pick your moments}}",
      paragraphs: [
        "Hi {name}, {reason, select, credits {{video} needs more credits than this workspace has left. Add credits, then try again from the run.} upload {YouTube keeps refusing to send us {video}. Upload the file from your device and the run carries on with it.} add {{video} is ready. Add the moments you want as clips by their start and end times.} other {the moments in {video} are ready. Choose the ones you want as clips.}}",
      ],
      cta: "Open the run",
      push: {
        title:
          "{reason, select, credits {Out of credits} upload {Upload the file instead} add {Add your moments} other {Your moments are ready}}",
        body: "{reason, select, credits {Add credits to finish {video}.} upload {YouTube keeps refusing {video}. Upload it from your device.} add {Add the moments you want from {video}.} other {Pick the moments you want from {video}.}}",
      },
    },

    "watch-new-video": {
      subject: "New video from {channel}: making clips",
      heading: "New episode found",
      paragraphs: [
        "Hi {name}, {channel} published {video}. We are making clips of it on Autopilot, with the settings you chose.",
        "Open the run to follow it. We will tell you when the first clips are ready.",
      ],
      cta: "Open the run",
      footnotes: [
        "You get this because {channel} is connected to your workspace. Pause it in Automations to stop.",
      ],
    },

    "watch-paused": {
      subject:
        "{reason, select, credits {Add credits: {channel} is paused} style {{channel} is paused: choose a caption look} setup {{channel} is paused: check its settings} other {{channel} could not be found}}",
      heading:
        "{reason, select, credits {You are out of credits} style {Its caption look is gone} setup {Its settings need a look} other {The channel is gone}}",
      paragraphs: [
        "Hi {name}, {reason, select, credits {the automation for {channel} ran out of credits and paused itself. Add credits, then resume it: the video it could not start is picked up first.} style {the automation for {channel} paused itself because its caption look is no longer available. Choose another in its settings, then resume it.} setup {the automation for {channel} paused itself because its settings no longer pass. Save them again, then resume it.} other {we could not find {channel} on YouTube, so its automation stopped. If the channel is back, resume it.}}",
      ],
      cta: "Open Automations",
      push: {
        title:
          "{reason, select, credits {Automation paused: out of credits} style {Automation paused} setup {Automation paused} other {Channel not found}}",
        body: "{reason, select, credits {Add credits, then resume {channel}.} style {Choose a caption look for {channel}, then resume it.} setup {Check the settings for {channel}, then resume it.} other {We could not find {channel} on YouTube.}}",
      },
    },

    // 2026-10-03, clip review: `verdict` is approved, changes, comment or
    // reopened; `by` is member, client (with `who`), guest (a client who gave no
    // name) or system.
    "clip-review": {
      subject:
        "{verdict, select, approved {{by, select, client {{who} (client)} guest {Your client} other {{who}}} approved a clip from {video}} changes {{by, select, client {{who} (client)} guest {Your client} other {{who}}} asked for changes to a clip from {video}} reopened {A clip from {video} needs review again} other {{by, select, client {{who} (client)} guest {Your client} other {{who}}} commented on a clip from {video}}}",
      heading:
        "{verdict, select, approved {Clip approved} changes {Changes requested} reopened {Back to review} other {New comment}}",
      paragraphs: [
        "Hi {name}, {verdict, select, approved {{by, select, client {{who} (client)} guest {Your client} other {{who}}} approved “{clip}”.} changes {{by, select, client {{who} (client)} guest {Your client} other {{who}}} asked for changes to “{clip}”.} reopened {“{clip}” changed after it was reviewed, so it is waiting for a review again.} other {{by, select, client {{who} (client)} guest {Your client} other {{who}}} commented on “{clip}”.}}",
        "{verdict, select, approved {What was approved is what goes out: if the clip is edited, it comes back for review.} changes {Open the run to read what they asked for.} reopened {Watch the new version, then approve it or ask for changes.} other {Open the run to read it.}}",
      ],
      cta: "Open the run",
      push: {
        title:
          "{verdict, select, approved {Clip approved} changes {Changes requested} reopened {Needs review again} other {New comment}}",
        body: "{verdict, select, approved {{by, select, client {{who} (client)} guest {Your client} other {{who}}} approved “{clip}”.} changes {{by, select, client {{who} (client)} guest {Your client} other {{who}}} asked for changes to “{clip}”.} reopened {“{clip}” changed and needs review again.} other {{by, select, client {{who} (client)} guest {Your client} other {{who}}} commented on “{clip}”.}}",
      },
    },
  },
};
