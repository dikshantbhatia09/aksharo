/**
 * Recorded-by-hand stand-ins for what YouTube serves to channel automations
 * (2026-10-02): a channel's upload feed and the head of a channel page, written
 * from the public formats (Atom + YouTube's `yt:` and Media RSS elements; the
 * page's canonical, RSS and Open Graph tags and its `ytInitialData`). The ids
 * are synthetic. Nothing in any test reaches YouTube; these are what the tests
 * hand the readers instead.
 *
 * Not a test file (no `.test.ts`); only the automations tests import it.
 */

export const CHANNEL = "UCAksharoTestChannel0001";
export const OTHER_CHANNEL = "UCAnotherTestChannel0002";

export interface FixtureEntry {
  readonly videoId: string;
  readonly title: string;
  readonly published: string;
  /** Default `/watch?v=`; a Short is linked to `/shorts/`. */
  readonly link?: string;
  readonly views?: number;
  readonly description?: string;
}

/** One `<entry>`, as the feed writes it. */
export function feedEntry(entry: FixtureEntry, channelId = CHANNEL): string {
  const link = entry.link ?? `https://www.youtube.com/watch?v=${entry.videoId}`;
  return `
 <entry>
  <id>yt:video:${entry.videoId}</id>
  <yt:videoId>${entry.videoId}</yt:videoId>
  <yt:channelId>${channelId}</yt:channelId>
  <title>${entry.title}</title>
  <link rel="alternate" href="${link}"/>
  <author>
   <name>Aksharo Test Kitchen</name>
   <uri>https://www.youtube.com/channel/${channelId}</uri>
  </author>
  <published>${entry.published}</published>
  <updated>${entry.published}</updated>
  <media:group>
   <media:title>${entry.title}</media:title>
   <media:content url="https://www.youtube.com/v/${entry.videoId}?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i1.ytimg.com/vi/${entry.videoId}/hqdefault.jpg" width="480" height="360"/>
   <media:description>${entry.description ?? "Full episode. Links below."}</media:description>
   <media:community>
    <media:starRating count="${String(entry.views ?? 0)}" average="5.00" min="1" max="5"/>
    <media:statistics views="${String(entry.views ?? 0)}"/>
   </media:community>
  </media:group>
 </entry>`;
}

/**
 * A whole feed. `channelIdForm` is how the feed writes its own channel id:
 * YouTube has written it both with and without its `UC`.
 */
export function feedXml(
  entries: readonly FixtureEntry[],
  options: {
    readonly channelId?: string;
    readonly bareChannelId?: boolean;
    readonly title?: string;
  } = {},
): string {
  const channelId = options.channelId ?? CHANNEL;
  const ownId = options.bareChannelId === true ? channelId.slice(2) : channelId;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"/>
 <id>yt:channel:${ownId}</id>
 <yt:channelId>${ownId}</yt:channelId>
 <title>${options.title ?? "Aksharo Test Kitchen"}</title>
 <link rel="alternate" href="https://www.youtube.com/channel/${channelId}"/>
 <author>
  <name>${options.title ?? "Aksharo Test Kitchen"}</name>
  <uri>https://www.youtube.com/channel/${channelId}</uri>
 </author>
 <published>2019-04-02T10:11:12+00:00</published>${entries.map((entry) => feedEntry(entry, channelId)).join("")}
</feed>
`;
}

/** The feed most tests read: a mix of every kind of entry, not in order. */
export const MIXED_FEED = feedXml([
  {
    videoId: "vid00000003",
    title: "Episode 41 &amp; the market &#8212; full talk",
    published: "2026-10-01T08:00:00+00:00",
    views: 1520,
  },
  {
    videoId: "vid00000005",
    title: "Why we moved to Pune",
    published: "2026-10-01T12:30:00+00:00",
    link: "https://www.youtube.com/shorts/vid00000005",
    views: 90_000,
  },
  {
    videoId: "vid00000004",
    title: "LIVE: Q&amp;A with listeners",
    published: "2026-10-01T10:00:00+00:00",
    views: 0,
  },
  {
    videoId: "vid00000002",
    title: "Budget cooking in 10 minutes #Shorts",
    published: "2026-09-30T09:00:00+00:00",
    views: 4_000,
  },
  {
    videoId: "vid00000001",
    title: "Episode 40: the long one",
    published: "2026-09-28T07:00:00+00:00",
    views: 12_345,
    description: "Two hours with our guest. Chapters below.",
  },
]);

/** The head of a channel page, as served to a logged-out browser, and a slice of its data. */
export function channelPage(
  options: {
    readonly canonical?: string;
    readonly rss?: string;
    readonly ogUrl?: string;
    readonly ogTitle?: string;
    readonly externalId?: string;
    readonly omitHeadIds?: boolean;
  } = {},
): string {
  const id = CHANNEL;
  const head =
    options.omitHeadIds === true
      ? ""
      : `
<link rel="canonical" href="${options.canonical ?? `https://www.youtube.com/channel/${id}`}">
<link rel="alternate" type="application/rss+xml" title="RSS" href="${options.rss ?? `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`}">
<meta property="og:url" content="${options.ogUrl ?? `https://www.youtube.com/channel/${id}`}">`;
  return `<!DOCTYPE html><html style="font-size: 10px;font-family: Roboto, Arial, sans-serif;" lang="en" system-icons typography typography-spacing><head><meta http-equiv="origin-trial" content="AAAA"><script nonce="x">var ytcfg={};</script>
<title>Aksharo Test Kitchen - YouTube</title>
<meta name="description" content="Recipes and long talks.">
<meta property="og:site_name" content="YouTube">${head}
<meta property="og:title" content="${options.ogTitle ?? "Aksharo Test Kitchen &amp; Friends"}">
<meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj">
<link rel="alternate" media="handheld" href="https://m.youtube.com/@aksharotestkitchen">
</head><body dir="ltr"><script nonce="x">var ytInitialData = {"metadata":{"channelMetadataRenderer":{"title":"Aksharo Test Kitchen","externalId":"${options.externalId ?? id}","vanityChannelUrl":"http://www.youtube.com/@aksharotestkitchen"}},"contents":{"featured":[{"channelId":"${OTHER_CHANNEL}"},{"channelId":"UCYetAnotherChannel00003"}]}};</script></body></html>`;
}

/** The classic exponential entity expansion. Refused on sight of the DTD. */
export const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<feed xmlns="http://www.w3.org/2005/Atom"><title>&lol9;</title></feed>`;

/** An external entity pointing at a local file (XXE). Refused on sight of the DTD. */
export const EXTERNAL_ENTITY = `<?xml version="1.0"?>
<!DOCTYPE feed [<!ENTITY secret SYSTEM "file:///C:/Windows/win.ini">]>
<feed xmlns="http://www.w3.org/2005/Atom"><title>&secret;</title></feed>`;

/** An external DTD by URL, lower-case, with no internal subset. */
export const EXTERNAL_DTD = `<?xml version="1.0"?><!doctype feed SYSTEM "http://169.254.169.254/latest/meta-data/"><feed xmlns="http://www.w3.org/2005/Atom"/>`;
