/**
 * Deterministic, no-auth-needed helpers for making a video's metadata easier
 * to find: a checklist scored against YouTube's own documented conventions
 * (not a model's guess), and a keyword-suggestion lookup against YouTube's
 * own public search-autocomplete endpoint — the same source real "tag
 * generator" tools use, no API key required.
 */

export interface SeoCheck {
  id: string;
  label: string;
  passed: boolean;
  message: string;
}

export interface SeoReport {
  checks: SeoCheck[];
  /** 0-100, percent of checks passed. */
  score: number;
}

/** Scores a title/description/tags combination against YouTube's own
 *  documented metadata conventions — title length, description length/links/
 *  hashtags, tag count/character budget, and title↔tag keyword overlap. Pure
 *  and synchronous: no network call, safe to run on every keystroke. */
export function checkSeo(input: { title: string; description: string; tags: string[] }): SeoReport {
  const checks: SeoCheck[] = [];
  const title = input.title.trim();
  const description = input.description.trim();
  const tags = input.tags.filter(Boolean);

  checks.push({
    id: "title-length",
    label: "Title length",
    passed: title.length >= 15 && title.length <= 100,
    message:
      title.length === 0 ? "No title set."
      : title.length < 15 ? `${title.length} characters — likely too short to be descriptive or keyword-rich.`
      : title.length > 100 ? `${title.length} characters — YouTube truncates titles past 100.`
      : `${title.length} characters — good length.`,
  });

  checks.push({
    id: "description-length",
    label: "Description length",
    passed: description.length >= 200,
    message:
      description.length >= 200 ? `${description.length} characters — enough for YouTube to index well.`
      : `Only ${description.length} characters — aim for 200+ so there's enough text to match search queries.`,
  });

  const hasLink = /https?:\/\//i.test(description);
  checks.push({
    id: "description-link",
    label: "Description has a link",
    passed: hasLink,
    message: hasLink ? "Found a link — good for driving traffic (streaming, socials, next video, etc.)." : "No link found — consider adding one.",
  });

  const hashtagCount = (description.match(/#\w+/g) ?? []).length;
  checks.push({
    id: "hashtags",
    label: "Hashtags",
    passed: hashtagCount >= 1 && hashtagCount <= 3,
    message:
      hashtagCount === 0 ? "No hashtags — YouTube shows up to 3 from your description above the title."
      : hashtagCount > 3 ? `${hashtagCount} hashtags — YouTube only displays the first 3 above the title; heavy hashtag use elsewhere risks a spam flag.`
      : `${hashtagCount} hashtag(s) — good.`,
  });

  checks.push({
    id: "tag-count",
    label: "Tag count",
    passed: tags.length >= 3 && tags.length <= 15,
    message:
      tags.length === 0 ? "No tags set — tags help YouTube understand context, especially for an ambiguous title."
      : tags.length > 15 ? `${tags.length} tags — more isn't better past ~15; focus on the most relevant ones.`
      : `${tags.length} tag(s) — good range.`,
  });

  const tagCharTotal = tags.join(",").length;
  checks.push({
    id: "tag-char-budget",
    label: "Tag character budget",
    passed: tagCharTotal <= 460,
    message: `${tagCharTotal}/500 characters used across all tags (YouTube's hard limit is 500).`,
  });

  const titleWords = title.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const tagsLower = tags.map((t) => t.toLowerCase());
  const overlaps = tags.length === 0 || tagsLower.some((t) => titleWords.some((w) => t.includes(w)));
  checks.push({
    id: "title-tag-overlap",
    label: "Title/tag keyword overlap",
    passed: overlaps,
    message: tags.length === 0 ? "N/A — no tags set yet." : overlaps ? "At least one tag echoes a title keyword — good for relevance." : "None of your tags share a keyword with the title.",
  });

  const score = Math.round((checks.filter((c) => c.passed).length / checks.length) * 100);
  return { checks, score };
}

/** Keyword/tag ideas from YouTube's own public search-autocomplete endpoint —
 *  the same source real people see typing into the YouTube search box, so
 *  it reflects actual search demand rather than a guess. No API key/auth. */
export async function suggestKeywords(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const text = await res.text();
  const match = /\[.*\]/s.exec(text);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as [string, [string, ...unknown[]][]];
    return (parsed[1] ?? []).map((row) => String(row[0])).filter(Boolean);
  } catch {
    return [];
  }
}
