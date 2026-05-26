# Future Plan: Semantic Brainrot Classification via Jetson VLLM

This document details the blueprint for integrating the local Jetson VLLM AI model (`http://10.0.0.30:8000`) to filter out spam, brainrot, and low-effort videos.

## Core Objectives
- Offload classification to the local Jetson GPU cluster rather than a cloud endpoint.
- Classify video metadata (title, channel, views, tags, description) as either `HIGH_QUALITY` or `BRAINROT/SPAM`.
- Cache all classification decisions locally in `localStorage` or `chrome.storage.local` so each video is only scanned once.

---

## Jetson VLLM Details
* **VLLM URL:** `http://10.0.0.30:8000`
* **Concurrency:** Supports up to 32 concurrent requests.
* **API Specification:** OpenAI-compatible API (`/v1/chat/completions` or `/v1/completions`).

---

## Proposed System Flow

```
Search Results / Feed Sync
         ↓
Check local Cache (Is Video ID already classified?)
      ├── YES → Apply saved classification (Show or Hide)
      └── NO  → Call Jetson VLLM
                  ↓
           Send Title, Channel, & Metadata in JSON Payload
                  ↓
           VLLM responds with classification + short reason
                  ↓
           Save result to cache & apply filter
```

---

## API Request Payload Schema

```json
POST http://10.0.0.30:8000/v1/chat/completions
Content-Type: application/json

{
  "model": "hermes-3-llama-3.1-8b", 
  "messages": [
    {
      "role": "system",
      "content": "You are a YouTube quality filter. Classify the video as either 'HIGH_QUALITY' or 'BRAINROT'. Brainrot includes: clickbait, extreme reaction face thumbnails, AI voiceover slop, low-effort listicles, drama, and gossip. Respond with a JSON object: {\"classification\": \"HIGH_QUALITY\" | \"BRAINROT\", \"reason\": \"string\"}"
    },
    {
      "role": "user",
      "content": "Title: 'IS THIS THE END OF JAVASCRIPT??? (Not Clickbait)', Channel: 'SlopTech', Duration: 90s, Views: 540000"
    }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.1
}
```

---

## Implementation Tasks

### 1. Nginx Proxy Configuration
To bypass CORS without exposing credentials or hitting routing hurdles, add a `/llm/` endpoint to the YouTube Wallgarden Nginx configuration:
```nginx
location /llm/ {
    rewrite ^/llm/(.*) /$1 break;
    proxy_pass http://10.0.0.30:8000;
    proxy_set_header Host $host;
    add_header 'Access-Control-Allow-Origin' '*' always;
}
```

### 2. Frontend Dashboard Integration (`app.js`)
* Create a `classificationCache` in local storage.
* Write an asynchronous worker `classifyVideo(video)` to queue VLLM requests.
* Add an "Enable AI Filter" toggle to Settings.

### 3. Extension Integration (`background.js`)
* Direct the background LLM pipeline to use the `/llm/v1/chat/completions` endpoint.
