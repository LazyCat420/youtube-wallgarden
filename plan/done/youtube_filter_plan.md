# YouTube Wall-Garden: "Anti-Brainrot" Extension Plan

## The Core Philosophy

The goal is to create a filter that actively removes low-effort, algorithmic bait, "shorts", and spam from the YouTube UI, while preserving high-quality recommendations that actually provide value.

Because evaluating "quality" is subjective and often requires context, we will build a **Multi-Layered Filtering System**, combining fast deterministic rules with intelligent AI scoring.

---

## The 3-Layer Filter Architecture

### Layer 1: The Baseline Purge (CSS & Selectors)

*The fastest layer. Runs instantly on page load to wipe out known bad UI elements.*

- **Action**: CSS/JS DOM removal of the `#shorts-inner-container` and `ytd-rich-shelf-renderer` elements (which house the Youtube Shorts shelves).
- **Action**: Strict Keyword/Channel Blacklist. If a channel name is "DramaAlert" or a title contains exactly "TIER LIST", it is instantly wiped from the DOM (`display: none;`).

### Layer 2: Heuristic Analysis (Math & Metadata)

*Calculated on the fly. Fast, but requires looking at the video's variables.*

- **Title Capitalization Ratio**: Titles that are >80% uppercase are highly likely to be clickbait.
- **Punctuation Abuse**: Titles with "???" or "!!!" or "$$$" indicate sensationalism.
- **Length Filtering** (optional): If available in the DOM, filter out all videos under 2 minutes (often just shorts in regular video clothing).

### Layer 3: Semantic "Brainrot" Scanner (LLM Integration)

*The heavy lifter. Runs asynchronously on the videos that survive Layers 1 & 2.*

- **How it works**: We extract the Video Title, Channel Name, and Thumbnail URL. We send this metadata to an LLM endpoint.
- **The Prompt**: The LLM is given a strict system prompt: *"Classify this YouTube video as either HIGH_QUALITY or BRAINROT. Brainrot includes: extreme reaction videos, low-effort algorithmic spam, AI voiceover slop. High quality includes: long-form essays, education, genuine entertainment."*
- **The Engine**: We can use a free, insanely fast cloud endpoint like **Groq (Llama 3)**, or if you prefer total privacy and no costs, we can point it to a **local Ollama instance** running on your PC.
- **The Cache:** To prevent blowing up API limits or your GPU, every Video ID's score is cached locally in the extension (`chrome.storage.local`). We only evaluate a video once!

---

## Extension Structure & Technologies

We will build this as a standard **Manifest V3 Chrome/Edge Extension**.

1. **`manifest.json`**: Requests permissions for `storage` (saving user settings/cache), `activeTab`, and host permissions for `*://*.youtube.com/*`.
2. **`content.js`**: The script injected into YouTube. It sets up a `MutationObserver` to watch for new videos appearing on the screen as you scroll, evaluates them against the 3 layers, and fades out the bad ones.
3. **`background.js`**: (Optional) Handles the background API calls to the LLM to avoid CORS issues on the frontend.
4. **`popup.html / JS`**: The user interface. A sleek "Wall-Garden" dashboard where you can:
    - Toggle Shorts blocking ON/OFF.
    - Set custom Blacklist/Whitelist keywords.
    - Adjust the strictness of the LLM filter.
    - Input your LLM API details (Groq key or LocalHost Port).

## Next Steps

1. Review this plan and let me know how you feel about Layer 3 (Local LLM vs Fast Cloud LLM).
2. Once approved, I will scaffold the basic extension (Manifest, simple popup).
3. We will build the DOM Observer (Layer 1) to block Shorts as a proof of concept.
4. We will add the AI layer.
