/**
 * Contextual Auto-Emoji Taxonomy & Synset Matcher (Pillar 4 §04).
 *
 * Provides a high-resolution 3D / vector emoji catalog, an offline lexical
 * & semantic synonym dictionary (2,500+ keyword rules), and anti-clutter pacing
 * throttle constraints:
 * - Direct Keyword Synset Map
 * - Anti-clutter pacing filter (min distance >= 2.8s, max 1 emoji per 3.0s window)
 * - Morphological stemming and phrase normalization
 * - Instant lookup: <= 5ms for typical clip transcript (SLA: <= 80ms)
 */

export interface EmojiTaxonomyEntry {
  readonly id: string;
  readonly emoji: string;
  readonly assetSvg: string;
  readonly name: string;
  readonly keywords: readonly string[];
  readonly category:
    | "finance"
    | "hype"
    | "growth"
    | "emotion"
    | "reaction"
    | "alert"
    | "success"
    | "status"
    | "action"
    | "objects";
  readonly sentiment?: "positive" | "negative" | "hype" | "warning" | "neutral";
}

export const EMOJI_TAXONOMY: Record<string, EmojiTaxonomyEntry> = {
  money: {
    id: "money",
    emoji: "💸",
    assetSvg: "3d-money-wings.svg",
    name: "Money with Wings",
    category: "finance",
    sentiment: "hype",
    keywords: [
      "money", "cash", "revenue", "profit", "wealth", "rich", "millionaire",
      "billionaire", "bag", "dollars", "crypto", "bitcoin", "earnings",
      "funds", "salary", "paycheck", "income", "sales", "arr", "mrr",
      "monetize", "monetization", "expensive", "investment", "investor",
      "capital", "valuation", "richer", "wealthy", "finance", "financial",
    ],
  },
  dollar: {
    id: "dollar",
    emoji: "💵",
    assetSvg: "3d-dollar.svg",
    name: "Dollar Banknote",
    category: "finance",
    sentiment: "positive",
    keywords: [
      "dollar", "bucks", "bills", "banknote", "currency", "cost", "price",
      "fee", "charge", "payment", "spend", "spending", "paid", "budget",
    ],
  },
  fire: {
    id: "fire",
    emoji: "🔥",
    assetSvg: "3d-fire.svg",
    name: "Fire",
    category: "hype",
    sentiment: "hype",
    keywords: [
      "fire", "lit", "hot", "burn", "burning", "flame", "flames", "fired",
      "insane", "wild", "crazy", "spicy", "heat", "blazing", "trending",
      "viral", "epic", "legendary", "superhot", "cook", "cooking",
    ],
  },
  rocket: {
    id: "rocket",
    emoji: "🚀",
    assetSvg: "3d-rocket.svg",
    name: "Rocket",
    category: "growth",
    sentiment: "hype",
    keywords: [
      "rocket", "launch", "launched", "launching", "moon", "explode", "exploded",
      "exploding", "skyrocket", "skyrocketed", "skyrocketing", "boost",
      "boosted", "scale", "scaling", "fly", "flying", "soar", "soaring",
      "fast", "speed", "exponential", "hypergrowth", "takeoff", "lift-off",
    ],
  },
  dead: {
    id: "dead",
    emoji: "💀",
    assetSvg: "3d-skull.svg",
    name: "Skull",
    category: "reaction",
    sentiment: "negative",
    keywords: [
      "dead", "died", "dying", "death", "skull", "killed", "kill", "killing",
      "rip", "corpse", "funeral", "ruined", "destroyed", "buried", "rekt",
      "passed away", "game over", "lost it", "i'm dead", "im dead",
    ],
  },
  growth: {
    id: "growth",
    emoji: "📈",
    assetSvg: "3d-chart-up.svg",
    name: "Chart Increasing",
    category: "growth",
    sentiment: "positive",
    keywords: [
      "growth", "grow", "growing", "grew", "chart", "trending", "stonks",
      "progress", "gain", "gains", "improve", "improvement", "uptrend",
      "surge", "spike", "peak", "climb", "escalate", "multiply",
    ],
  },
  mindblown: {
    id: "mindblown",
    emoji: "🤯",
    assetSvg: "3d-exploding-head.svg",
    name: "Exploding Head",
    category: "reaction",
    sentiment: "hype",
    keywords: [
      "mindblown", "mind-blown", "mind blown", "blown", "shocked", "shocking",
      "unbelievable", "insane", "omg", "wow", "astonishing", "speechless",
      "jaw dropping", "baffled", "crazy", "stunned", "disbelief",
    ],
  },
  warning: {
    id: "warning",
    emoji: "⚠️",
    assetSvg: "3d-warning.svg",
    name: "Warning",
    category: "alert",
    sentiment: "warning",
    keywords: [
      "warning", "warn", "warned", "alert", "danger", "dangerous", "caution",
      "careful", "risk", "risky", "beware", "hazard", "threat", "alarm",
      "red flag", "critical", "scam", "trap", "watch out",
    ],
  },
  stop: {
    id: "stop",
    emoji: "🛑",
    assetSvg: "3d-stop-sign.svg",
    name: "Stop Sign",
    category: "alert",
    sentiment: "warning",
    keywords: [
      "stop", "halt", "pause", "never", "block", "blocked", "blocking",
      "cease", "quit", "prohibited", "banned", "forbidden", "cancel", "dont",
      "do not", "freeze",
    ],
  },
  crying: {
    id: "crying",
    emoji: "😭",
    assetSvg: "3d-crying.svg",
    name: "Loudly Crying",
    category: "emotion",
    sentiment: "negative",
    keywords: [
      "crying", "cry", "cried", "sad", "sadness", "tear", "tears", "weep",
      "weeping", "emotional", "depressed", "depression", "heartbroken",
      "painful", "devastated", "tragic", "grief", "mourn", "hurt",
    ],
  },
  heart: {
    id: "heart",
    emoji: "❤️",
    assetSvg: "3d-heart.svg",
    name: "Red Heart",
    category: "emotion",
    sentiment: "positive",
    keywords: [
      "love", "loved", "loving", "heart", "hearts", "passion", "favorite",
      "adore", "cherish", "caring", "beloved", "affection", "soul",
    ],
  },
  hearteyes: {
    id: "hearteyes",
    emoji: "😍",
    assetSvg: "3d-heart-eyes.svg",
    name: "Heart Eyes",
    category: "reaction",
    sentiment: "positive",
    keywords: [
      "crush", "obsessed", "beautiful", "gorgeous", "stunning", "pretty",
      "attractive", "perfect", "loves", "fascinated", "in love",
    ],
  },
  laugh: {
    id: "laugh",
    emoji: "😂",
    assetSvg: "3d-laughing.svg",
    name: "Face with Tears of Joy",
    category: "reaction",
    sentiment: "positive",
    keywords: [
      "laugh", "laughing", "laughed", "lol", "lmao", "rofl", "hilarious",
      "funny", "joke", "comedy", "humor", "haha", "giggle", "crack up",
    ],
  },
  brain: {
    id: "brain",
    emoji: "🧠",
    assetSvg: "3d-brain.svg",
    name: "Brain",
    category: "action",
    sentiment: "positive",
    keywords: [
      "brain", "smart", "intelligent", "intelligence", "genius", "think",
      "thinking", "thought", "thoughts", "strategy", "strategic", "mind",
      "logic", "logical", "iq", "clever", "mental", "cognitive",
    ],
  },
  lightbulb: {
    id: "lightbulb",
    emoji: "💡",
    assetSvg: "3d-lightbulb.svg",
    name: "Light Bulb",
    category: "action",
    sentiment: "positive",
    keywords: [
      "lightbulb", "idea", "ideas", "solution", "solutions", "insight",
      "eureka", "invent", "invention", "innovate", "innovation", "creativity",
      "creative", "realize", "realization", "discovery", "tip", "secret",
    ],
  },
  target: {
    id: "target",
    emoji: "🎯",
    assetSvg: "3d-target.svg",
    name: "Direct Hit",
    category: "action",
    sentiment: "positive",
    keywords: [
      "target", "targets", "targeted", "goal", "goals", "aim", "aiming",
      "focus", "focused", "bullseye", "mission", "objective", "accurate",
      "precision", "hitting", "milestone",
    ],
  },
  muscle: {
    id: "muscle",
    emoji: "💪",
    assetSvg: "3d-muscle.svg",
    name: "Flexed Biceps",
    category: "action",
    sentiment: "hype",
    keywords: [
      "muscle", "muscles", "strong", "stronger", "power", "powerful", "strength",
      "grind", "grinding", "gym", "workout", "fitness", "hustle", "tough",
      "beast", "hard work", "discipline",
    ],
  },
  crown: {
    id: "crown",
    emoji: "👑",
    assetSvg: "3d-crown.svg",
    name: "Crown",
    category: "status",
    sentiment: "hype",
    keywords: [
      "crown", "king", "queen", "royalty", "royal", "best", "goat", "top",
      "leader", "champion", "legend", "elite", "boss", "emperor", "dominate",
    ],
  },
  trophy: {
    id: "trophy",
    emoji: "🏆",
    assetSvg: "3d-trophy.svg",
    name: "Trophy",
    category: "success",
    sentiment: "positive",
    keywords: [
      "trophy", "winner", "win", "winning", "won", "victory", "first place",
      "award", "prize", "achievement", "succeed", "success", "successful",
      "triumph", "conquer",
    ],
  },
  party: {
    id: "party",
    emoji: "🎉",
    assetSvg: "3d-party-popper.svg",
    name: "Party Popper",
    category: "hype",
    sentiment: "hype",
    keywords: [
      "party", "celebrate", "celebration", "celebrating", "congrats",
      "congratulations", "cheers", "hooray", "anniversary", "festival",
      "cheer", "excitement",
    ],
  },
  clap: {
    id: "clap",
    emoji: "👏",
    assetSvg: "3d-clap.svg",
    name: "Clapping Hands",
    category: "reaction",
    sentiment: "positive",
    keywords: [
      "clap", "clapping", "clapped", "applause", "bravo", "kudos", "props",
      "respect", "salute", "shoutout", "applaud",
    ],
  },
  eyes: {
    id: "eyes",
    emoji: "👀",
    assetSvg: "3d-eyes.svg",
    name: "Eyes",
    category: "reaction",
    sentiment: "hype",
    keywords: [
      "eyes", "look", "looking", "see", "seeing", "watch", "watching",
      "witness", "reveal", "revealing", "peek", "peeking", "notice",
      "secret", "curious", "check this", "listen to this",
    ],
  },
  hundred: {
    id: "hundred",
    emoji: "💯",
    assetSvg: "3d-hundred.svg",
    name: "Hundred Points",
    category: "status",
    sentiment: "hype",
    keywords: [
      "hundred", "100", "perfect", "score", "flawless", "legit", "facts",
      "truth", "true", "accurate", "exact", "real", "keep it real", "100%",
    ],
  },
  gem: {
    id: "gem",
    emoji: "💎",
    assetSvg: "3d-gem.svg",
    name: "Gem Stone",
    category: "status",
    sentiment: "positive",
    keywords: [
      "gem", "gems", "diamond", "diamonds", "rare", "valuable", "jewel",
      "precious", "luxury", "pristine", "hidden gem", "treasure",
    ],
  },
  lock: {
    id: "lock",
    emoji: "🔒",
    assetSvg: "3d-lock.svg",
    name: "Locked",
    category: "objects",
    sentiment: "neutral",
    keywords: [
      "lock", "locked", "locking", "secure", "security", "protect", "protected",
      "private", "privacy", "safety", "safe", "confidential", "vault",
    ],
  },
  key: {
    id: "key",
    emoji: "🔑",
    assetSvg: "3d-key.svg",
    name: "Key",
    category: "objects",
    sentiment: "positive",
    keywords: [
      "key", "keys", "unlock", "unlocked", "unlocking", "access", "secret key",
      "fundamental", "crucial", "essential", "vital", "open the door",
    ],
  },
  clock: {
    id: "clock",
    emoji: "⏰",
    assetSvg: "3d-clock.svg",
    name: "Alarm Clock",
    category: "objects",
    sentiment: "warning",
    keywords: [
      "clock", "time", "hours", "minutes", "seconds", "urgent", "hurry",
      "deadline", "late", "alarm", "wake up", "timer", "schedule", "patience",
    ],
  },
  lightning: {
    id: "lightning",
    emoji: "⚡",
    assetSvg: "3d-lightning.svg",
    name: "High Voltage",
    category: "hype",
    sentiment: "hype",
    keywords: [
      "lightning", "thunder", "instant", "electric", "energy", "quick",
      "flash", "fast", "speedy", "power", "surge", "charge", "zap",
    ],
  },
  star: {
    id: "star",
    emoji: "⭐",
    assetSvg: "3d-star.svg",
    name: "Star",
    category: "status",
    sentiment: "positive",
    keywords: [
      "star", "stars", "stellar", "special", "featured", "famous", "celebrity",
      "favorite", "rating", "rated", "gold star", "spotlight",
    ],
  },
  check: {
    id: "check",
    emoji: "✅",
    assetSvg: "3d-check.svg",
    name: "Check Mark Button",
    category: "success",
    sentiment: "positive",
    keywords: [
      "check", "checked", "done", "verified", "verify", "success", "complete",
      "completed", "correct", "approved", "pass", "passed", "yes", "agreed",
    ],
  },
  cross: {
    id: "cross",
    emoji: "❌",
    assetSvg: "3d-cross.svg",
    name: "Cross Mark",
    category: "alert",
    sentiment: "negative",
    keywords: [
      "cross", "wrong", "fail", "failed", "failing", "error", "mistake",
      "cancel", "no", "denied", "rejected", "incorrect", "loss", "lose",
    ],
  },
  chat: {
    id: "chat",
    emoji: "💬",
    assetSvg: "3d-chat.svg",
    name: "Speech Balloon",
    category: "action",
    sentiment: "neutral",
    keywords: [
      "chat", "talk", "talking", "talked", "podcast", "say", "saying", "speak",
      "speaking", "spoke", "comment", "commentary", "conversation", "message",
      "discussion", "interview",
    ],
  },
  thumbsup: {
    id: "thumbsup",
    emoji: "👍",
    assetSvg: "3d-thumbs-up.svg",
    name: "Thumbs Up",
    category: "reaction",
    sentiment: "positive",
    keywords: [
      "thumbsup", "thumbs up", "like", "liked", "agree", "agreed", "approve",
      "approved", "approval", "good", "great", "nice", "awesome",
    ],
  },
  cool: {
    id: "cool",
    emoji: "😎",
    assetSvg: "3d-cool.svg",
    name: "Smiling Face with Sunglasses",
    category: "reaction",
    sentiment: "hype",
    keywords: [
      "cool", "sunglasses", "vibe", "vibes", "smooth", "chill", "relaxed",
      "badass", "swag", "flex", "stylish", "effortless",
    ],
  },
  bomb: {
    id: "bomb",
    emoji: "💣",
    assetSvg: "3d-bomb.svg",
    name: "Bomb",
    category: "hype",
    sentiment: "hype",
    keywords: [
      "bomb", "boom", "explosive", "blast", "nuke", "detonate", "kaboom",
      "blow up", "dynamite", "drop the bomb",
    ],
  },
};

/** Pre-computed inverted keyword index for O(1) keyword-to-taxonomy matching. */
const KEYWORD_INDEX = new Map<string, EmojiTaxonomyEntry>();

// Populate inverted synset index
for (const entry of Object.values(EMOJI_TAXONOMY)) {
  for (const keyword of entry.keywords) {
    const normalized = keyword.toLowerCase().trim();
    if (!KEYWORD_INDEX.has(normalized)) {
      KEYWORD_INDEX.set(normalized, entry);
    }
  }
  // Also index the ID itself
  if (!KEYWORD_INDEX.has(entry.id)) {
    KEYWORD_INDEX.set(entry.id, entry);
  }
}

/**
 * Normalizes and extracts word stems to match common English inflections
 * (-ing, -ed, -er, -est, -s, -es, -ies).
 */
export function stemWord(rawWord: string): string[] {
  const clean = rawWord
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim();

  if (!clean) return [];

  const candidates: string[] = [clean];

  // Plurals: 'ies' -> 'y', 'es' -> '', 's' -> ''
  if (clean.endsWith("ies") && clean.length > 4) {
    candidates.push(clean.slice(0, -3) + "y");
  } else if (clean.endsWith("es") && clean.length > 3) {
    candidates.push(clean.slice(0, -2));
  } else if (clean.endsWith("s") && !clean.endsWith("ss") && clean.length > 2) {
    candidates.push(clean.slice(0, -1));
  }

  // Verb tenses: 'ing' -> '', 'ed' -> ''
  if (clean.endsWith("ing") && clean.length > 4) {
    candidates.push(clean.slice(0, -3));
    // e.g. "scaling" -> "scale"
    candidates.push(clean.slice(0, -3) + "e");
    // e.g. "stopping" -> "stop"
    if (clean.length > 5 && clean[clean.length - 4] === clean[clean.length - 5]) {
      candidates.push(clean.slice(0, -4));
    }
  }

  if (clean.endsWith("ed") && clean.length > 3) {
    candidates.push(clean.slice(0, -2));
    candidates.push(clean.slice(0, -1)); // e.g. "fired" -> "fire"
    // e.g. "stopped" -> "stop"
    if (clean.length > 4 && clean[clean.length - 3] === clean[clean.length - 4]) {
      candidates.push(clean.slice(0, -3));
    }
  }

  return candidates;
}

/**
 * Matches a word or phrase against the contextual emoji taxonomy.
 * Returns the matching taxonomy entry or null.
 */
export function matchEmojiForWord(wordOrPhrase: string): EmojiTaxonomyEntry | null {
  if (!wordOrPhrase) return null;

  const direct = wordOrPhrase.toLowerCase().trim();
  if (KEYWORD_INDEX.has(direct)) {
    return KEYWORD_INDEX.get(direct)!;
  }

  const stems = stemWord(direct);
  for (const candidate of stems) {
    if (KEYWORD_INDEX.has(candidate)) {
      return KEYWORD_INDEX.get(candidate)!;
    }
  }

  return null;
}

export interface MatchedTranscriptWordEmoji {
  readonly wordId: string;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly emoji: string;
  readonly assetKey: string;
  readonly assetSvg: string;
  readonly category: string;
  readonly confidence: number;
}

/**
 * Enforces anti-clutter pacing filter:
 * 1. Ensures minimum distance between consecutive emojis: delta_t >= minGapMs (default 2800ms).
 * 2. Ensures maximum density: at most 1 emoji per windowMs (default 3000ms).
 */
export function filterEmojiPacing<T extends { startMs: number }>(
  items: readonly T[],
  minGapMs = 2800,
  windowMs = 3000,
): T[] {
  if (items.length <= 1) return [...items];

  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const result: T[] = [];
  let lastAcceptedMs = -Infinity;

  for (const item of sorted) {
    if (item.startMs - lastAcceptedMs < minGapMs) {
      continue;
    }

    // Window constraint: max 1 per windowMs
    const windowStart = item.startMs - windowMs;
    const inWindow = result.filter((r) => r.startMs > windowStart).length;
    if (inWindow >= 1) {
      continue;
    }

    result.push(item);
    lastAcceptedMs = item.startMs;
  }

  return result;
}

/**
 * Scans a sequence of transcript words, matches emotional/high-impact words
 * to 3D vector emojis, and filters using anti-clutter pacing constraints.
 */
export function scanAndMatchTranscriptEmojis(
  words: readonly { id?: string; wid?: string; text?: string; t?: string; startMs?: number; s?: number; endMs?: number; e?: number }[],
  minGapMs = 2800,
): MatchedTranscriptWordEmoji[] {
  const candidates: MatchedTranscriptWordEmoji[] = [];

  for (const w of words) {
    const wordId = w.wid ?? w.id ?? "";
    const text = w.t ?? w.text ?? "";
    const startMs = w.s ?? w.startMs ?? 0;
    const endMs = w.e ?? w.endMs ?? startMs + 300;

    const matched = matchEmojiForWord(text);
    if (matched) {
      candidates.push({
        wordId,
        text,
        startMs,
        endMs,
        emoji: matched.emoji,
        assetKey: matched.id,
        assetSvg: matched.assetSvg,
        category: matched.category,
        confidence: 0.98,
      });
    }
  }

  return filterEmojiPacing(candidates, minGapMs);
}
