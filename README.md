# 🌿 Wallgarden

**Take back your YouTube feed.** A Chrome extension that filters out algorithmic spam, Shorts, clickbait, and brainrot — using CSS rules, heuristics, and a smart learning blocklist.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## ✨ Features

### 🧠 Smart Learning Blocklist
- **Intercepts** your "Not Interested" and "Don't Recommend Channel" clicks
- **Permanently blocks** channels YouTube keeps pushing back
- **Learns keywords** from rejected videos — auto-blocks similar content after repeated rejections
- **Manual management** — add/remove channels directly from the popup
- **Export/Import** your blocklist as JSON

### 🏠 Homepage Cleanup
| Filter | What it blocks |
|--------|---------------|
| Shorts | Shorts shelf, sidebar link, individual shorts in feed |
| Breaking News | Breaking news shelf |
| Trending | Trending shelf and sidebar link |
| Community Posts | Post cards in the feed |
| People Also Watched | "People also watched" shelf |
| Ads | Banner promos, promoted cards, in-feed ads |
| Movies & Shows | Storefront shelves |

### 🎬 Watch Page Cleanup
- Merchandise shelves
- Super Thanks / donation prompts
- "Shorts remixing this video" shelf
- Live chat replay
- Info cards & end screen overlays
- "Clip" & "Thanks" buttons (opt-in)

### 🚫 Global Annoyances
- "Try YouTube Premium" banners
- Notification bell popups
- YouTube Music upsells

### 📐 Heuristic Filters
- **ALL CAPS titles** — blocks videos with >80% uppercase letters
- **Excessive punctuation** — blocks titles with `???` or `!!!` spam

---

## 📦 Installation

### From Source (Developer Mode)

1. Clone this repo:
   ```bash
   git clone https://github.com/YOUR_USERNAME/youtube-wallgarden.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (top right toggle)

4. Click **Load unpacked** and select the `extension/` folder

5. Pin the 🌿 Wallgarden icon to your toolbar

### Usage

1. Click the Wallgarden icon in your toolbar
2. Toggle filters on/off as needed
3. Click **Save Settings**
4. Browse YouTube — blocked content is hidden instantly

The Smart Blocklist learns automatically as you use YouTube's built-in "Not Interested" and "Don't Recommend Channel" options.

---

## 🏗️ Architecture

```
extension/
├── manifest.json          # Chrome Extension Manifest V3
├── popup/
│   ├── popup.html         # Settings UI
│   ├── popup.css          # Dark theme styling
│   └── popup.js           # Settings load/save + blocklist management
└── scripts/
    └── content.js         # Core filtering engine
```

### Filtering Layers

1. **CSS Rules** — Instant hiding of known spam elements via injected `<style>` tags
2. **Heuristics** — Title analysis (ALL CAPS ratio, punctuation patterns) via MutationObserver
3. **Smart Blocklist** — Learns from your "Not Interested" / "Don't Recommend" clicks, persists to `chrome.storage.local`

---

## 🔧 How the Smart Blocklist Works

```
You click "Don't Recommend Channel" on YouTube
        ↓
Wallgarden intercepts the click (capture phase)
        ↓
Extracts channel name + title keywords
        ↓
Channel → added to permanent blocklist
Keywords → weighted by rejection frequency
        ↓
Stored in chrome.storage.local (persists forever)
        ↓
Future videos from that channel are auto-hidden
Keywords appearing in 3+ rejections trigger auto-blocking
```

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/block-something`)
3. Commit your changes
4. Push and open a PR

---

## 📄 License

MIT — do whatever you want with it.
