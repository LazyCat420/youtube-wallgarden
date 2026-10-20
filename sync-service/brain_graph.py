"""
Smart Brain Graph & Algorithmic Facet Engine for YouTube Wallgarden
===================================================================

Runs on NAS CPU inside `sync-service` (< 10ms per call, zero LLM tokens) so the
Jetson (`nemotron35`) is reserved strictly for creative topic generation and
liked-video topic mining.

Provides:
1. Contrastive discriminating-facet extraction (`extract_discriminating_facets`):
   Burning a compound topic like "vegan bbq" protects positive anchors ("bbq")
   while permanently blocking the discriminating modifier ("vegan") and its
   semantic association cluster ("plant-based", "meatless", "seitan", "tofu", ...).
2. Personalized PageRank (PPR) + Beta-Bernoulli Thompson Sampling (`rank_brain_topics`):
   Ranks topics from time-decayed likes (30-day half-life), plays, opens,
   unengaged impressions, and negative signals.
3. Algorithmic Grounding (`ground_topics_algorithmically`):
   Replaces LLM `/wallgarden/judge-topics` with a deterministic < 5ms scorer over
   scraped YouTube result titles, channel diversity, views, and spam markers.
"""

from __future__ import annotations

import math
import random
import re
import time
from collections import defaultdict

LIKE_HALF_LIFE_MS = 30 * 86400 * 1000
STOPWORDS = {
    "the", "a", "an", "of", "and", "for", "in", "on", "to", "with", "at", "by",
    "from", "into", "over", "under", "long", "term", "new", "best", "top",
    "how", "diy", "advanced", "basic", "modern", "high", "low", "big", "small",
    "good", "great", "guide", "tutorial", "video", "videos", "full", "process",
}

# Curated association clusters for polarizing modifiers. When a user burns a
# topic containing one of these modifiers (and the modifier is not itself in
# the user's positive corpus), its associated terms are blocked alongside it
# while sparing the positive subject (e.g. "bbq", "cooking", "gardening").
FACET_ASSOCIATION_GRAPH: dict[str, list[str]] = {
    "vegan": ["vegan", "plant-based", "plant based", "meatless", "seitan", "tofu", "tempeh", "veganism", "dairy-free"],
    "plant-based": ["plant-based", "plant based", "vegan", "meatless", "seitan", "tofu", "tempeh"],
    "vegetarian": ["vegetarian", "meatless", "ovo-lacto", "plant-based"],
    "meatless": ["meatless", "vegan", "plant-based", "plant based", "seitan"],
    "keto": ["keto", "ketogenic", "carnivore diet", "low carb keto"],
    "asmr": ["asmr", "whispering", "tingles", "mukbang asmr"],
    "mukbang": ["mukbang", "eating show", "food challenge"],
    "prank": ["prank", "pranks", "social experiment prank"],
    "reaction": ["reaction", "reacts to", "first time reacting"],
    "reacts": ["reacts", "reaction", "reacts to"],
    "unboxing": ["unboxing", "haul", "mystery box"],
    "crypto": ["crypto", "cryptocurrency", "bitcoin", "altcoin", "web3", "memecoin", "nft"],
    "nft": ["nft", "nfts", "web3", "crypto art", "metaverse"],
    "forex": ["forex", "day trading", "binary options", "scalping signals"],
    "astrology": ["astrology", "horoscope", "zodiac sign", "natal chart", "tarot"],
    "tarot": ["tarot", "tarot reading", "astrology", "horoscope", "manifestation"],
    "manifestation": ["manifestation", "law of attraction", "subliminal", "chakra"],
    "chakra": ["chakra", "chakras", "reiki", "crystal healing", "aura cleansing"],
    "roblox": ["roblox", "brookhaven", "robux", "blox fruits"],
    "fortnite": ["fortnite", "vbucks", "battle royale montage"],
}

SPAM_TITLE_RE = re.compile(
    r"(\b(you won't believe|gone wrong|must watch|shocking|insane|exposed|tier list|"
    r"reacts to|first time hearing|try not to|top 10|top 5|ranked worst to best)\b|"
    r"[!?]{3,}|#shorts\b)",
    re.IGNORECASE,
)


def normalize_phrase(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def tokenize_topic(phrase: str) -> list[str]:
    norm = normalize_phrase(phrase)
    tokens = [w for w in re.split(r"[^a-z0-9-]+", norm) if len(w) > 2 and w not in STOPWORDS]
    return tokens


def _decayed_like_weight(ts_ms: float | int | None, now_ms: float) -> float:
    if not ts_ms or not isinstance(ts_ms, (int, float)):
        return 1.0
    if ts_ms <= 1e11:
        return 1.0
    age_ms = max(0.0, now_ms - float(ts_ms))
    return math.pow(0.5, age_ms / LIKE_HALF_LIFE_MS)


def collect_positive_corpus(doc: dict, extra_positive_phrases: list[str] | None = None, now_ms: float | None = None) -> tuple[ dict[str, float], set[str] ]:
    """Return (topic_weights, positive_token_set) from liked videos, mined topics,
    played topics, and explicit positive phrases."""
    now = now_ms if now_ms is not None else time.time() * 1000.0
    topic_weights: dict[str, float] = defaultdict(float)
    pos_tokens: set[str] = set()

    ratings = (doc or {}).get("ratings") or {}
    mined = (doc or {}).get("mined") or {}
    signals = (doc or {}).get("topicSignals") or {}

    for vid, rec in ratings.items():
        if not isinstance(rec, dict) or rec.get("r") != 5:
            continue
        w = _decayed_like_weight(rec.get("t"), now)
        v = rec.get("v") or {}
        labels = set()
        if v.get("discoveryTopic"):
            labels.add(normalize_phrase(v["discoveryTopic"]))
        for mt in v.get("matchedTopics") or []:
            if isinstance(mt, str) and not mt.startswith("disliked:"):
                labels.add(normalize_phrase(mt))
        for mt in (mined.get(vid) or {}).get("topics") or []:
            if isinstance(mt, str):
                labels.add(normalize_phrase(mt))
        for lb in labels:
            if lb:
                topic_weights[lb] += w
                if w >= 0.25:
                    pos_tokens.update(tokenize_topic(lb))
        if w >= 0.25 and isinstance(v.get("title"), str) and v["title"] != "Liked Video (Synced)":
            pos_tokens.update(tokenize_topic(v["title"]))

    for topic, srec in signals.items():
        if not isinstance(srec, dict):
            continue
        c_map = srec.get("c") or {}
        plays = sum((per.get("play", 0) or 0) for per in c_map.values() if isinstance(per, dict))
        opens = sum((per.get("open", 0) or 0) for per in c_map.values() if isinstance(per, dict))
        if plays > 0 or opens >= 2:
            norm_t = normalize_phrase(topic)
            topic_weights[norm_t] += plays * 1.0 + opens * 0.35
            pos_tokens.update(tokenize_topic(norm_t))

    for p in extra_positive_phrases or []:
        norm_p = normalize_phrase(p)
        if norm_p:
            topic_weights[norm_p] = max(topic_weights[norm_p], 1.0)
            pos_tokens.update(tokenize_topic(norm_p))

    return dict(topic_weights), pos_tokens


def extract_discriminating_facets(
    burned_phrase: str,
    doc: dict | None = None,
    extra_positive_phrases: list[str] | None = None,
    now_ms: float | None = None,
) -> dict:
    """Decompose a burned phrase into protected positive anchors vs permanent
    rejected facets + semantic association aliases.

    Example:
      burned_phrase = "vegan bbq", positive corpus contains "texas brisket bbq"
      -> protected = ["bbq"]
      -> rejected_facets = {"vegan": {"facet": "vegan", "fromTopic": "vegan bbq",
                            "aliases": ["vegan", "plant-based", ...], "permanent": True}}
    """
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    norm = normalize_phrase(burned_phrase)
    tokens = tokenize_topic(norm)
    _, pos_tokens = collect_positive_corpus(doc or {}, extra_positive_phrases, now)

    protected = [w for w in tokens if w in pos_tokens]
    unprotected = [w for w in tokens if w not in pos_tokens]

    extracted: dict[str, dict] = {}
    has_positive_anchor = len(protected) > 0

    for w in unprotected:
        is_known_modifier = w in FACET_ASSOCIATION_GRAPH
        if has_positive_anchor or is_known_modifier:
            raw_aliases = FACET_ASSOCIATION_GRAPH.get(w, [w])
            safe_aliases = []
            for al in raw_aliases:
                al_norm = normalize_phrase(al)
                al_tokens = tokenize_topic(al_norm)
                if al_norm and not any(tok in pos_tokens for tok in al_tokens):
                    if al_norm not in safe_aliases:
                        safe_aliases.append(al_norm)
            if w not in safe_aliases:
                safe_aliases.insert(0, w)
            extracted[w] = {
                "facet": w,
                "fromTopic": norm,
                "protectedAnchors": protected,
                "aliases": safe_aliases,
                "t": now,
                "permanent": True,
            }

    return {
        "burnedPhrase": norm,
        "protectedAnchors": protected,
        "rejectedFacets": extracted,
    }


def is_rejected_by_facets(text: str, rejected_facets: dict | None) -> str | None:
    """Return the matching rejected facet key if `text` matches any active
    rejected facet or its aliases on word boundaries."""
    if not text or not isinstance(rejected_facets, dict) or not rejected_facets:
        return None
    norm = normalize_phrase(text)
    if not norm:
        return None
    for facet, rec in rejected_facets.items():
        if not isinstance(rec, dict) or rec.get("deleted"):
            continue
        aliases = rec.get("aliases") or [facet]
        for al in aliases:
            al_norm = normalize_phrase(str(al))
            if not al_norm:
                continue
            pattern = r"(?:^|[^a-z0-9])" + re.escape(al_norm) + r"(?:$|[^a-z0-9])"
            if re.search(pattern, norm):
                return facet
    return None


def rank_brain_topics(doc: dict, n: int = 30, now_ms: float | None = None, deterministic: bool = False) -> dict:
    """Build the co-like / signal association graph from `doc`, run Personalized
    PageRank (PPR) with restart alpha=0.25, and combine with Beta-Bernoulli
    Thompson sampling to rank candidate topics and surface an exploration frontier.
    """
    now = now_ms if now_ms is not None else time.time() * 1000.0
    ratings = (doc or {}).get("ratings") or {}
    mined = (doc or {}).get("mined") or {}
    signals = (doc or {}).get("topicSignals") or {}
    rejected_facets = (doc or {}).get("rejectedFacets") or {}

    adj: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    seed_weights: dict[str, float] = defaultdict(float)
    topic_likes: dict[str, float] = defaultdict(float)
    topic_dislikes: dict[str, float] = defaultdict(float)

    for vid, rec in ratings.items():
        if not isinstance(rec, dict):
            continue
        r = rec.get("r", 0)
        if r not in (5, -5):
            continue
        v = rec.get("v") or {}
        topics = []
        if v.get("discoveryTopic"):
            topics.append(normalize_phrase(v["discoveryTopic"]))
        for mt in v.get("matchedTopics") or []:
            if isinstance(mt, str) and not mt.startswith("disliked:"):
                topics.append(normalize_phrase(mt))
        for mt in (mined.get(vid) or {}).get("topics") or []:
            if isinstance(mt, str):
                topics.append(normalize_phrase(mt))
        topics = [t for t in dict.fromkeys(topics) if t and not is_rejected_by_facets(t, rejected_facets)]
        if not topics:
            continue

        if r == 5:
            w = _decayed_like_weight(rec.get("t"), now)
            for t in topics:
                topic_likes[t] += w
                seed_weights[t] += w * 2.0
            for i in range(len(topics)):
                for j in range(i + 1, len(topics)):
                    a, b = topics[i], topics[j]
                    adj[a][b] += w
                    adj[b][a] += w
        elif r == -5:
            for t in topics:
                topic_dislikes[t] += 1.0

    all_topics = set(seed_weights.keys()) | set(signals.keys()) | set(adj.keys())
    all_topics = {
        normalize_phrase(t)
        for t in all_topics
        if t and not is_rejected_by_facets(t, rejected_facets)
    }

    # Add token-overlap edges between topics sharing distinctive tokens so
    # multi-hop Personalized PageRank bridges related niches.
    by_token: dict[str, list[str]] = defaultdict(list)
    for t in all_topics:
        for tok in tokenize_topic(t):
            by_token[tok].append(t)
    for tok, members in by_token.items():
        if 2 <= len(members) <= 25:
            edge_w = 0.35 / math.sqrt(len(members))
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    a, b = members[i], members[j]
                    adj[a][b] += edge_w
                    adj[b][a] += edge_w

    # Personalized PageRank (15 power iterations, restart alpha = 0.25)
    alpha = 0.25
    total_seed = sum(max(0.0, v) for v in seed_weights.values())
    if total_seed <= 0 and all_topics:
        p0 = {t: 1.0 / len(all_topics) for t in all_topics}
    else:
        p0 = {t: max(0.0, seed_weights.get(t, 0.0)) / max(1e-9, total_seed) for t in all_topics}

    ppr = dict(p0)
    for _ in range(15):
        nxt = {t: alpha * p0.get(t, 0.0) for t in all_topics}
        for u in all_topics:
            nbrs = adj.get(u)
            if not nbrs:
                nxt[u] += (1.0 - alpha) * ppr.get(u, 0.0)
                continue
            out_w = sum(w for nb, w in nbrs.items() if nb in all_topics and w > 0)
            if out_w <= 0:
                nxt[u] += (1.0 - alpha) * ppr.get(u, 0.0)
                continue
            share = (1.0 - alpha) * ppr.get(u, 0.0) / out_w
            for nb, w in nbrs.items():
                if nb in all_topics and w > 0:
                    nxt[nb] = nxt.get(nb, 0.0) + share * w
        ppr = nxt

    rng = random.Random(42) if deterministic else random
    ranked = []
    explore_frontier = []

    for t in sorted(all_topics):
        srec = signals.get(t) if isinstance(signals.get(t), dict) else {}
        c_map = (srec or {}).get("c") or {}
        imp = sum((per.get("imp", 0) or 0) for per in c_map.values() if isinstance(per, dict))
        play = sum((per.get("play", 0) or 0) for per in c_map.values() if isinstance(per, dict))
        open_c = sum((per.get("open", 0) or 0) for per in c_map.values() if isinstance(per, dict))
        likes = topic_likes.get(t, 0.0)
        dislikes = topic_dislikes.get(t, 0.0)

        # Skip topics that are IGNORED (8+ impressions, 0 plays/opens, decayed likes < 0.5)
        if likes < 0.5 and imp >= 8 and play == 0 and open_c == 0:
            continue

        unengaged_imp = max(0, imp - play - open_c)
        alpha_post = 1.0 + 2.0 * likes + 1.2 * play + 0.5 * open_c
        beta_post = 1.0 + 0.15 * unengaged_imp + 3.0 * dislikes
        mean_post = alpha_post / (alpha_post + beta_post)
        ts_draw = mean_post if deterministic else rng.betavariate(alpha_post, beta_post)
        ppr_score = ppr.get(t, 0.0)

        combined = 0.55 * ts_draw + 0.45 * min(1.0, ppr_score * 15.0)
        role = "core" if (likes >= 0.5 or play >= 2) else ("explore" if imp == 0 else "adjacent")
        item = {
            "topic": t,
            "score": round(combined, 4),
            "ppr": round(ppr_score, 5),
            "posteriorMean": round(mean_post, 4),
            "likes": round(likes, 3),
            "plays": int(play),
            "impressions": int(imp),
            "role": role,
        }
        ranked.append(item)
        if imp == 0 and ppr_score > 0 and likes < 0.5:
            explore_frontier.append(item)

    ranked.sort(key=lambda x: (-x["score"], x["topic"]))
    explore_frontier.sort(key=lambda x: (-x["ppr"], x["topic"]))

    return {
        "recommendations": ranked[: max(1, n)],
        "exploreFrontier": explore_frontier[:15],
        "rejectedFacets": rejected_facets,
        "totalActiveTopics": len(ranked),
    }


def ground_topics_algorithmically(items: list[dict], rejected_facets: dict | None = None) -> list[dict]:
    """Deterministic < 5ms grounding scorer replacing `/wallgarden/judge-topics`
    on the Jetson. Returns `{ topic, verdict, reason, metrics }` for each item.
    """
    verdicts = []
    current_year = time.gmtime().tm_year

    for item in items or []:
        if not isinstance(item, dict) or not item.get("topic"):
            continue
        topic = normalize_phrase(str(item["topic"]))
        rejected_hit = is_rejected_by_facets(topic, rejected_facets)
        if rejected_hit:
            verdicts.append({
                "topic": item["topic"],
                "verdict": "SLOP",
                "reason": f"matches rejected facet '{rejected_hit}'",
            })
            continue

        results = item.get("results") or []
        titles = item.get("titles") or [r.get("title", "") for r in results if isinstance(r, dict)]
        titles = [str(t) for t in titles if t]
        if not titles:
            verdicts.append({"topic": item["topic"], "verdict": "DEAD", "reason": "no search results"})
            continue

        topic_tokens = set(tokenize_topic(topic))
        channels = set()
        views_list = []
        years_list = []
        spam_hits = 0
        token_matches = 0
        rejected_title_hits = 0

        for idx, t_str in enumerate(titles):
            if SPAM_TITLE_RE.search(t_str):
                spam_hits += 1
            if is_rejected_by_facets(t_str, rejected_facets):
                rejected_title_hits += 1
            t_tokens = set(tokenize_topic(t_str))
            if not topic_tokens or (topic_tokens & t_tokens):
                token_matches += 1
            if idx < len(results) and isinstance(results[idx], dict):
                r = results[idx]
                if r.get("channel"):
                    channels.add(str(r["channel"]).strip().lower())
                if isinstance(r.get("views"), (int, float)):
                    views_list.append(float(r["views"]))
                if isinstance(r.get("year"), int):
                    years_list.append(r["year"])

        for ch in item.get("channels") or []:
            if ch:
                channels.add(str(ch).strip().lower())

        n_res = len(titles)
        spam_ratio = (spam_hits + rejected_title_hits) / n_res
        match_ratio = token_matches / n_res
        median_views = sorted(views_list)[len(views_list) // 2] if views_list else 5000.0
        max_year = max(years_list) if years_list else current_year

        if max_year < current_year - 10 and median_views < 300:
            verdict = "DEAD"
            reason = "dormant results with negligible views"
        elif spam_ratio >= 0.5 or match_ratio < 0.2:
            verdict = "SLOP"
            reason = f"spam_ratio={spam_ratio:.2f}, match_ratio={match_ratio:.2f}"
        elif match_ratio >= 0.5 and spam_ratio <= 0.25 and (len(channels) >= 2 or n_res < 3):
            verdict = "REAL"
            reason = f"match_ratio={match_ratio:.2f}, channels={len(channels)}"
        else:
            verdict = "MIXED"
            reason = f"match_ratio={match_ratio:.2f}, spam_ratio={spam_ratio:.2f}"

        verdicts.append({
            "topic": item["topic"],
            "verdict": verdict,
            "reason": reason,
        })

    return verdicts
