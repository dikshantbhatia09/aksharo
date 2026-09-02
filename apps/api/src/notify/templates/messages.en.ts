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
      footnotes: ["Local exports and browser-native exports never use processing minutes."],
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

    "share-comment": {
      subject: "{count, plural, one {# new comment} other {# new comments}} on {project}",
      heading: "{count, plural, one {# new comment} other {# new comments}}",
      paragraphs: [
        "Hi {name}, {author} left {count, plural, one {a comment} other {# comments}} on {project}.",
      ],
      cta: "Open the review",
      footnotes: ["Comments are grouped, so a busy review is one message and not twenty."],
    },
  },
};
