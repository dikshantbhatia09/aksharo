"""Trend-Aware Hashtag Recommendation Engine (Pillar 7 §03).

Constructs a mathematically balanced 3-Tier Pyramid Hashtag Bundle:
  - Tier 1 (Broad Category - 1–2 tags): 10M+ posts (#artificialintelligence, #technology)
  - Tier 2 (Community Subculture - 3–4 tags): 100k–1M posts (#aiproductivity, #techtok)
  - Tier 3 (Hyper-Specific Topic - 2–3 tags): < 100k posts (#vectordatabases, #ragpipeline)

Adapts bundle size and tone to platform best practices:
  - YouTube Shorts: 3–5 tags (max 5)
  - Instagram Reels: 5–8 tags (max 8)
  - TikTok: 3–6 tags (max 6)
  - LinkedIn: 2–3 tags (max 3, professional, bans #fyp / #viral tags)
  - X / Twitter: 1–3 tags (max 3)
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

__all__ = [
  "HashtagTier",
  "PyramidBundle",
  "assemble_pyramid_bundle",
  "classify_tier",
  "clean_hashtag",
  "detect_domain",
  "get_platform_hashtags",
]

HashtagTier = Literal["BROAD", "COMMUNITY", "NICHE"]

_HASHTAG_CHARS: Final[int] = 40
_BANNED_LINKEDIN: Final[frozenset[str]] = frozenset(
  {"#fyp", "#viral", "#foryou", "#trending", "#tiktok", "#reels", "#explore"}
)


@dataclass(frozen=True, slots=True)
class PyramidBundle:
  broad: tuple[str, ...]
  community: tuple[str, ...]
  niche: tuple[str, ...]
  all: tuple[str, ...]
  formatted: str
  domain: str
  platform: str


# ---------------------------------------------------------------------------
# Curated 15-Domain Taxonomy with Volume Tiers
# ---------------------------------------------------------------------------

_TAXONOMY: Final[dict[str, dict[str, tuple[str, ...]]]] = {
  "ai": {
    "triggers": (
      "ai", "artificial intelligence", "machine learning", "deep learning", "llm",
      "gpt", "rag", "vector", "prompt", "openai", "claude", "gemini", "neural",
      "embeddings", "agent", "generative ai", "sora", "midjourney"
    ),
    "broad": (
      "#ai", "#artificialintelligence", "#machinelearning", "#deeplearning",
      "#datascience", "#generativeai", "#openai", "#futureofai", "#robotics", "#techai"
    ),
    "community": (
      "#aiproductivity", "#aitools", "#chatgptprompts", "#promptengineering",
      "#midjourneyart", "#llms", "#aiagent", "#computervision", "#nlp", "#aistartups",
      "#buildwithai", "#ainews", "#claudeai", "#geminiai", "#langchain", "#aivideo"
    ),
    "niche": (
      "#vectordatabases", "#ragpipeline", "#retrievalaugmentedgeneration",
      "#localllms", "#ollamarunner", "#qdrant", "#chromadb", "#lorafinetuning",
      "#groqchip", "#vllmengine", "#contextwindow", "#semanticchunking",
      "#diffusionmodels", "#transformerarchitecture", "#multimodalai"
    ),
  },
  "tech": {
    "triggers": (
      "tech", "technology", "coding", "software", "developer", "programming",
      "javascript", "python", "typescript", "react", "nextjs", "devops", "cloud",
      "aws", "docker", "kubernetes", "backend", "frontend", "git"
    ),
    "broad": (
      "#tech", "#technology", "#coding", "#programming", "#developer",
      "#softwareengineer", "#computerscience", "#webdev", "#cloudcomputing", "#cybersecurity"
    ),
    "community": (
      "#techtok", "#codetok", "#devlife", "#frontenddev", "#backenddev",
      "#fullstack", "#learntocode", "#javascriptdev", "#pythoncode", "#reactjs",
      "#nextjs", "#devops", "#awscloud", "#dockercontainer", "#typescript"
    ),
    "niche": (
      "#microfrontends", "#turbopack", "#bunruntime", "#trpcapi",
      "#serverlesspostgres", "#drizzleorm", "#prismaorm", "#rustlang", "#golangdev",
      "#ziglang", "#ebpf", "#systemdesigninterview", "#eventdrivenarchitecture", "#graphqlapi"
    ),
  },
  "business": {
    "triggers": (
      "business", "startup", "founder", "saas", "entrepreneur", "revenue",
      "sales", "bootstrapping", "venture", "funding", "pricing", "growth", "b2b",
      "customer", "pitch", "ceo"
    ),
    "broad": (
      "#business", "#entrepreneur", "#startup", "#success", "#smallbusiness",
      "#leadership", "#businessowner", "#entrepreneurship", "#innovation", "#management"
    ),
    "community": (
      "#saasgrowth", "#startuplife", "#indiehackers", "#buildinpublic", "#founders",
      "#venturecapital", "#b2bsaas", "#businessstrategy", "#bootstrapping", "#growthmindset",
      "#smallbiztips", "#startupfunding", "#seedround", "#angelinvesting", "#producthunt"
    ),
    "niche": (
      "#arrgrowth", "#churnreduction", "#productledgrowth", "#gtmstrategy",
      "#customeracquisitioncost", "#lifetimevalue", "#b2bgrowth", "#burnratemanagement",
      "#capitable", "#saasmetrics", "#icpdefinition", "#coldemailoutreach", "#funnelconversion"
    ),
  },
  "finance": {
    "triggers": (
      "finance", "money", "investing", "stocks", "real estate", "passive income",
      "wealth", "etf", "dividend", "budget", "portfolio", "roi", "savings", "tax"
    ),
    "broad": (
      "#finance", "#money", "#investing", "#wealth", "#personalfinance",
      "#stocks", "#financialfreedom", "#realestate", "#economy", "#savings"
    ),
    "community": (
      "#investingtips", "#stockmarketnews", "#passiveincome", "#financialindependence",
      "#firecommunity", "#wealthbuilding", "#dividendinvesting", "#budgetingtips",
      "#compoundinterest", "#indexfunds", "#etfinvesting", "#realestateinvesting", "#moneyhacks"
    ),
    "niche": (
      "#dcfvaluation", "#optionstrading", "#rothirasavings", "#401krollover",
      "#realestatesyndication", "#caprates", "#househackingstrategy", "#coveredcalls",
      "#valueinvestingprinciples", "#cashflowquadrant", "#taxlieninvesting", "#1031exchange"
    ),
  },
  "marketing": {
    "triggers": (
      "marketing", "seo", "branding", "copywriting", "advertising", "conversion",
      "email marketing", "social media", "funnel", "lead generation", "ads", "ctr"
    ),
    "broad": (
      "#marketing", "#digitalmarketing", "#socialmediamarketing", "#branding",
      "#advertising", "#contentmarketing", "#seo", "#sales", "#growth", "#businessmarketing"
    ),
    "community": (
      "#marketingtips", "#growthhacking", "#socialmediatips", "#copywriting",
      "#emailmarketing", "#contentcreator", "#inboundmarketing", "#influencermarketing",
      "#brandstrategy", "#performancemarketing", "#facebookads", "#googleads"
    ),
    "niche": (
      "#hookrate", "#scrollstoppers", "#roasoptimization", "#ctrboost",
      "#emaildeliverability", "#coldoutbound", "#klaviyoflows", "#ugccreators",
      "#conversionrateoptimization", "#landingpagecopy", "#attributionmodeling"
    ),
  },
  "creator_economy": {
    "triggers": (
      "creator", "youtube", "video editing", "podcast", "shorts", "reels",
      "tiktok", "filmmaking", "thumbnail", "premiere", "broll", "hook", "storytelling"
    ),
    "broad": (
      "#creator", "#creatoreconomy", "#contentcreator", "#youtube", "#videoediting",
      "#videoproduction", "#filmmaking", "#storytelling", "#media", "#influencer"
    ),
    "community": (
      "#youtubetips", "#videocreator", "#premierepro", "#davinciresolve",
      "#aftereffects", "#capcut", "#videoeditor", "#podcastlife", "#streamer",
      "#shortformcontent", "#verticalvideo", "#reelscreator", "#thumbnaildesign"
    ),
    "niche": (
      "#youtubeshortsalgorithm", "#retentionediting", "#patterninterrupt",
      "#jcutsound", "#punchinzoom", "#subtitlesanimation", "#motiongraphicstutorial",
      "#sounddesignvideo", "#lutcolorgrade", "#monetizationstrategies", "#dynamiccaptions"
    ),
  },
  "productivity": {
    "triggers": (
      "productivity", "habits", "notion", "discipline", "time management",
      "morning routine", "focus", "deep work", "organization", "goals", "routine"
    ),
    "broad": (
      "#productivity", "#timemanagement", "#motivation", "#mindset", "#habits",
      "#discipline", "#successmindset", "#focus", "#goals", "#lifestyle"
    ),
    "community": (
      "#productivityhacks", "#deepwork", "#notion", "#notionapp", "#atomichabits",
      "#morningroutine", "#workfromhome", "#studygram", "#organizedlife",
      "#selfimprovement", "#goalsetting", "#pomodorotechnique", "#secondbrain"
    ),
    "niche": (
      "#timelocking", "#notiondashboardtemplate", "#obsidiannotes", "#pkmworkflow",
      "#eisenhowermatrix", "#habitstacking", "#dopaminedetoxchallenge", "#contextswitching",
      "#energyauditing", "#flowstatehacks", "#quarterlygoals", "#taskbatching"
    ),
  },
  "fitness": {
    "triggers": (
      "fitness", "gym", "workout", "muscle", "nutrition", "calories", "protein",
      "bodybuilding", "hypertrophy", "bench press", "squat", "calisthenics", "deadlift"
    ),
    "broad": (
      "#fitness", "#gym", "#workout", "#fit", "#fitnessmotivation",
      "#bodybuilding", "#health", "#training", "#fitlife", "#exercise"
    ),
    "community": (
      "#gymtok", "#gymrat", "#calisthenics", "#hypertrophy", "#fitnesstips",
      "#strengthtraining", "#legday", "#pushpulllegs", "#nutritiontips",
      "#highprotein", "#weightlossjourney", "#fatloss", "#mealprep"
    ),
    "niche": (
      "#progressiveoverload", "#rpe_scale", "#hypertrophytraining",
      "#creatinemonohydrate", "#mindmuscleconnection", "#rotatorcuffwarmup",
      "#hipthrusttechnique", "#deficitcalorietracker", "#macrosplit", "#deloadweek"
    ),
  },
  "gaming": {
    "triggers": (
      "gaming", "gamer", "esports", "twitch", "gameplay", "fps", "rpg", "steam",
      "playstation", "xbox", "pc gaming", "clutch", "highlights", "streamer"
    ),
    "broad": (
      "#gaming", "#gamer", "#videogames", "#gameplay", "#games",
      "#playstation", "#xbox", "#nintendo", "#pcgaming", "#twitch"
    ),
    "community": (
      "#gamingcommunity", "#gametok", "#esports", "#twitchstreamer", "#clutchmoment",
      "#gamehighlights", "#gamingsetup", "#battlestation", "#indiegames", "#rpg",
      "#fpsgames", "#speedrun", "#gamingclips"
    ),
    "niche": (
      "#unrealengine5dev", "#unitygamedev", "#godotengine", "#pixelartgame",
      "#hitboxanalysis", "#framespersecondboost", "#raytracingon", "#custommechanicalkeyboard",
      "#aimtrainingroutine", "#crosshairplacement", "#speedrunstrats"
    ),
  },
  "crypto": {
    "triggers": (
      "crypto", "bitcoin", "ethereum", "web3", "blockchain", "defi", "solana",
      "altcoin", "trading", "wallet", "nft", "token", "btc", "eth"
    ),
    "broad": (
      "#crypto", "#cryptocurrency", "#bitcoin", "#btc", "#ethereum",
      "#eth", "#blockchain", "#web3", "#finance", "#trading"
    ),
    "community": (
      "#cryptonews", "#cryptotrading", "#altcoins", "#defi", "#nftcommunity",
      "#hodl", "#solana", "#bullmarket", "#binance", "#coinbase", "#cryptowallet"
    ),
    "niche": (
      "#zeroknowledgeproofs", "#zkrollups", "#layer2scaling", "#uniswappools",
      "#liquiditypools", "#impermanentloss", "#gasfeeoptimization", "#hardwalletsecurity",
      "#stakingyields", "#tokenomicsmodel", "#onchainanalysis"
    ),
  },
  "comedy": {
    "triggers": (
      "comedy", "funny", "humor", "joke", "jokes", "skit", "parody", "standup",
      "relatable", "prank", "hilarious", "laugh", "meme", "memes"
    ),
    "broad": (
      "#comedy", "#funny", "#humor", "#memes", "#lol", "#jokes",
      "#entertainment", "#fun", "#laugh", "#hilarious"
    ),
    "community": (
      "#comedyvideo", "#comedytok", "#standupcomedy", "#relatablememes",
      "#funnyvideos", "#comedyreels", "#skits", "#parody", "#povcomedy",
      "#relatable", "#desicomedy", "#laughter", "#dankmemes"
    ),
    "niche": (
      "#punchlineaccent", "#improvsketch", "#dryhumoronly", "#observationalstandup",
      "#cringecomedy", "#roastbattles", "#crowdworkcomedy", "#dadjokesunite",
      "#deadpanhumor", "#slapstickcomedy", "#darkcomedyjokes"
    ),
  },
  "education": {
    "triggers": (
      "education", "science", "history", "psychology", "learning", "study",
      "facts", "books", "philosophy", "curiosity", "school", "university"
    ),
    "broad": (
      "#education", "#learning", "#knowledge", "#study", "#science",
      "#history", "#students", "#school", "#facts", "#mind"
    ),
    "community": (
      "#didyouknow", "#edutok", "#studytips", "#funfacts", "#curiosity",
      "#psychologyfacts", "#philosophy", "#sciencefacts", "#historybuff",
      "#booklover", "#lifelonglearning", "#criticalthinking"
    ),
    "niche": (
      "#cognitivebiases", "#quantumphysicsbasics", "#neuroplasticityexplained",
      "#stoicismdaily", "#socraticmethod", "#evolutionarybiology", "#astrophysicstok",
      "#memorypalacetechnique", "#feynmanmethod", "#spacedrepetitionanki"
    ),
  },
  "food": {
    "triggers": (
      "food", "cooking", "recipe", "chef", "foodie", "baking", "dinner",
      "delicious", "meal", "kitchen", "street food", "taste", "restaurant"
    ),
    "broad": (
      "#food", "#foodie", "#cooking", "#recipe", "#instafood",
      "#foodporn", "#delicious", "#yummy", "#cheflife", "#dinner"
    ),
    "community": (
      "#foodtok", "#easyrecipes", "#streetfood", "#homecooking", "#baking",
      "#quickrecipes", "#indianfood", "#healthyrecipes", "#comfortfood",
      "#dessert", "#vegetarianrecipes", "#airfryerrecipes"
    ),
    "niche": (
      "#sourdoughstarterbread", "#castironskilletcooking", "#sousvidecooking",
      "#knifehandlingtechnique", "#emulsionmaking", "#fermentationprocess",
      "#spiceblendingsecret", "#wokheiessence", "#platingtechniques", "#maillardreaction"
    ),
  },
  "travel": {
    "triggers": (
      "travel", "wanderlust", "adventure", "vacation", "trip", "backpacking",
      "destinations", "mountains", "beach", "hotel", "explore", "nature"
    ),
    "broad": (
      "#travel", "#travelgram", "#wanderlust", "#adventure", "#explore",
      "#vacation", "#holiday", "#nature", "#travelblogger", "#trip"
    ),
    "community": (
      "#traveltok", "#solotravel", "#backpacking", "#travelvlog", "#budgettravel",
      "#travelhacks", "#roadtrip", "#vanlife", "#hiddenplaces", "#traveltips",
      "#destinationguide", "#beautifuldestinations"
    ),
    "niche": (
      "#carryononlypacking", "#cheapflightsfinder", "#hostellifevibes",
      "#wildcampinguk", "#offthebeatenpathadventures", "#hiddengemstravel",
      "#solofemaletraveler", "#digitalnomadstays", "#visafreecountry", "#scenicdrives"
    ),
  },
  "fashion": {
    "triggers": (
      "fashion", "style", "ootd", "outfit", "streetwear", "clothing", "vintage",
      "sneakers", "aesthetic", "wardrobe", "thrift", "menswear"
    ),
    "broad": (
      "#fashion", "#style", "#ootd", "#fashionblogger", "#streetwear",
      "#mensfashion", "#womensfashion", "#outfit", "#clothing", "#vintage"
    ),
    "community": (
      "#fashiontok", "#outfitinspo", "#styletips", "#thrifted", "#streetstyle",
      "#wardrobeessentials", "#outfitoftheday", "#sneakerhead", "#minimalistfashion",
      "#stylingideas", "#capsulewardrobe", "#thrifthaul"
    ),
    "niche": (
      "#capsulewardrobetips", "#coloranalysisguide", "#trousersbreakfit",
      "#layeringpiecesinspo", "#linenclothingstyling", "#sneakerscustomizing",
      "#tailoringadjustments", "#vintagedenimfinds", "#minimalistfootwear", "#oldmoneyaesthetic"
    ),
  },
}


# ---------------------------------------------------------------------------
# Sanitization & Classification
# ---------------------------------------------------------------------------

def clean_hashtag(token: str) -> str | None:
  """Sanitizes an input string to strict valid hashtag syntax.

  Prefixed with `#`, no punctuation, no emojis, no spaces, preserving
  valid unicode letters, combining marks, digits, and underscores.
  """
  if not token or not isinstance(token, str):
    return None
  stripped = token.strip().lstrip("#")
  body = "".join(
    char
    for char in unicodedata.normalize("NFC", stripped)
    if char == "_" or unicodedata.category(char)[0] in "LMN"
  )
  while body and unicodedata.category(body[0])[0] == "M":
    body = body[1:]
  if not body:
    return None
  return "#" + body[:_HASHTAG_CHARS]


def classify_tier(tag: str) -> HashtagTier:
  """Classifies a hashtag into BROAD, COMMUNITY, or NICHE tier."""
  cleaned = clean_hashtag(tag)
  if not cleaned:
    return "COMMUNITY"

  tag_lower = cleaned.casefold()

  # Check exact match across curated taxonomy
  for data in _TAXONOMY.values():
    if tag_lower in (t.casefold() for t in data["broad"]):
      return "BROAD"
    if tag_lower in (t.casefold() for t in data["community"]):
      return "COMMUNITY"
    if tag_lower in (t.casefold() for t in data["niche"]):
      return "NICHE"

  # Heuristic length and keyword indicators
  length = len(cleaned) - 1
  if length <= 6 or any(
    w in tag_lower for w in ("tech", "ai", "money", "gym", "food", "travel", "style", "business")
  ):
    return "BROAD"
  if length >= 16 or any(
    w in tag_lower for w in ("pipeline", "database", "framework", "architecture", "strategy", "technique")
  ):
    return "NICHE"
  return "COMMUNITY"


# ---------------------------------------------------------------------------
# Domain Detection
# ---------------------------------------------------------------------------

def detect_domain(text: str, title: str = "") -> str:
  """Detects primary domain from transcript and title text."""
  combined = f"{title} {text}".casefold()
  best_domain = "tech"
  highest_score = -1

  for domain, data in _TAXONOMY.items():
    score = 0
    for trigger in data["triggers"]:
      if trigger in combined:
        score += 3 if " " in trigger else 1
    if score > highest_score:
      highest_score = score
      best_domain = domain

  return best_domain


# ---------------------------------------------------------------------------
# 3-Tier Pyramid Assembler
# ---------------------------------------------------------------------------

def assemble_pyramid_bundle(
  text: str,
  title: str = "",
  platform: str = "default",
  custom_tags: Sequence[str] = (),
  limit: int | None = None,
) -> PyramidBundle:
  """Assembles a balanced 3-Tier Pyramid Hashtag Bundle.

  Tier distribution:
    - Tier 1: Broad Category (1-2 tags, 10M+)
    - Tier 2: Community Subculture (3-4 tags, 100k-1M)
    - Tier 3: Hyper-Specific Topic (2-3 tags, <100k)

  Adapts strictly to platform constraints:
    - YouTube Shorts: 3-5 tags
    - Instagram Reels: 5-8 tags
    - TikTok: 3-6 tags
    - LinkedIn: 2-3 tags (bans #fyp / #viral tags)
    - X: 1-3 tags
  """
  domain = detect_domain(text, title)
  domain_data = _TAXONOMY.get(domain, _TAXONOMY["tech"])
  combined = f"{title} {text}".casefold()

  # Platform quota targets: (broad, community, niche, max_total)
  plat = platform.lower()
  if plat == "youtube":
    broad_q, comm_q, niche_q, max_t = 1, 2, 1, 5
  elif plat == "instagram":
    broad_q, comm_q, niche_q, max_t = 2, 3, 2, 8
  elif plat == "tiktok":
    broad_q, comm_q, niche_q, max_t = 1, 3, 1, 6
  elif plat == "linkedin":
    broad_q, comm_q, niche_q, max_t = 1, 2, 0, 3
  elif plat in ("x", "twitter"):
    broad_q, comm_q, niche_q, max_t = 1, 1, 0, 3
  else:
    broad_q, comm_q, niche_q, max_t = 2, 3, 2, 7

  if limit is not None:
    max_t = limit

  seen: set[str] = set()
  broad_list: list[str] = []
  comm_list: list[str] = []
  niche_list: list[str] = []

  def is_banned(tag: str) -> bool:
    if plat == "linkedin" and tag.casefold() in _BANNED_LINKEDIN:
      return True
    return False

  # Incorporate user-specified custom tags first if valid
  for raw in custom_tags:
    clean = clean_hashtag(raw)
    if not clean or clean.casefold() in seen or is_banned(clean):
      continue
    seen.add(clean.casefold())
    tier = classify_tier(clean)
    if tier == "BROAD" and len(broad_list) < broad_q:
      broad_list.append(clean)
    elif tier == "COMMUNITY" and len(comm_list) < comm_q:
      comm_list.append(clean)
    elif tier == "NICHE" and len(niche_list) < niche_q:
      niche_list.append(clean)

  # Rank domain tags by contextual keyword overlap in text
  def rank_tags(tags: Sequence[str]) -> list[str]:
    def score(t: str) -> int:
      base = t.lstrip("#").casefold()
      return 3 if base in combined else 1
    return sorted(tags, key=score, reverse=True)

  for tag in rank_tags(domain_data["broad"]):
    if len(broad_list) >= broad_q:
      break
    if tag.casefold() not in seen and not is_banned(tag):
      seen.add(tag.casefold())
      broad_list.append(tag)

  for tag in rank_tags(domain_data["community"]):
    if len(comm_list) >= comm_q:
      break
    if tag.casefold() not in seen and not is_banned(tag):
      seen.add(tag.casefold())
      comm_list.append(tag)

  for tag in rank_tags(domain_data["niche"]):
    if len(niche_list) >= niche_q:
      break
    if tag.casefold() not in seen and not is_banned(tag):
      seen.add(tag.casefold())
      niche_list.append(tag)

  all_tags = (broad_list + comm_list + niche_list)[:max_t]

  return PyramidBundle(
    broad=tuple(broad_list),
    community=tuple(comm_list),
    niche=tuple(niche_list),
    all=tuple(all_tags),
    formatted=" ".join(all_tags),
    domain=domain,
    platform=platform,
  )


def get_platform_hashtags(
  text: str,
  title: str = "",
  platform: str = "default",
  custom_tags: Sequence[str] = (),
) -> list[str]:
  """Convenience helper returning the ordered list of sanitized platform hashtags."""
  bundle = assemble_pyramid_bundle(
    text=text,
    title=title,
    platform=platform,
    custom_tags=custom_tags,
  )
  return list(bundle.all)
