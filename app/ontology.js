// ============================================================
//  Wallgarden Ontology Engine (v2)
//  Three-signal knowledge graph with smart pruning & spreading
// ============================================================

// ── Lifecycle Classification ─────────────────────────────────
const PERMANENT_NODE_TYPES = new Set(["Channel"]);
const EPHEMERAL_NODE_TYPES = new Set(["Topic", "ContentPattern"]);

// ── Pruning Constants ────────────────────────────────────────
const CO_VIEWED_DECAY_DAYS = 14;       // CO_VIEWED edges decay after 14 days
const CO_LIKED_DECAY_DAYS = 30;        // CO_LIKED/CO_DISLIKED edges decay after 30 days
const DECAY_RATE = 0.05;               // 5% weight loss per prune cycle
const EDGE_KILL_THRESHOLD = 0.1;       // Edges with |weight| below this are deleted
const NODE_KILL_THRESHOLD = -6;        // Ephemeral nodes below this weight are deleted
const GRAPH_MAX_NODES = 2000;          // Hard cap (down from 10K — localStorage safe)
const GRAPH_MAX_EDGES = 5000;          // Hard cap (down from 20K)

// ── Rating-to-prune scheduling ───────────────────────────────
const RATINGS_PER_PRUNE = 10;
let _ratingsSincePrune = 0;

// ── Negative Propagation ─────────────────────────────────────
const PROPAGATION_FACTOR = 0.5;        // Neighbors lose edge_weight × 0.5

// ── Channel Similarity ───────────────────────────────────────
const MIN_SHARED_TOPICS_FOR_SIMILARITY = 3;

// ── Helpers ─────────────────────────────────────────────────

function makeNodeId(label) {
    return "node_" + label.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function makeEdgeId(sourceId, targetId) {
    return "edge_" + sourceId + "__" + targetId;
}

// ── Node CRUD ────────────────────────────────────────────────

function graphUpsertNode(graph, label, type, weightDelta) {
    const id = makeNodeId(label);
    if (!graph.nodes[id]) {
        graph.nodes[id] = {
            id, label: label.trim().toLowerCase(), type,
            weight: 0, hitCount: 0,
            createdAt: Date.now(), lastSeen: Date.now()
        };
    }
    graph.nodes[id].weight += weightDelta;
    graph.nodes[id].hitCount += 1;
    graph.nodes[id].lastSeen = Date.now();
    return id;
}

function graphDeleteNode(graph, nodeId) {
    delete graph.nodes[nodeId];
    // Cascade: remove all edges referencing this node
    Object.keys(graph.edges).forEach(edgeId => {
        const e = graph.edges[edgeId];
        if (e.source === nodeId || e.target === nodeId) {
            delete graph.edges[edgeId];
        }
    });
    // Remove from clusters
    if (graph.clusters) {
        Object.values(graph.clusters).forEach(members => {
            const idx = members.indexOf(nodeId);
            if (idx > -1) members.splice(idx, 1);
        });
    }
}

// ── Edge CRUD ────────────────────────────────────────────────

function graphUpsertEdge(graph, sourceId, targetId, type, weightDelta, descriptionFn) {
    const id = makeEdgeId(sourceId, targetId);
    if (!graph.edges[id]) {
        graph.edges[id] = {
            id, source: sourceId, target: targetId,
            type, weight: 0,
            description: "",
            createdAt: Date.now(), lastUpdated: Date.now()
        };
    }
    graph.edges[id].weight += weightDelta;
    graph.edges[id].lastUpdated = Date.now();
    if (descriptionFn) {
        graph.edges[id].description = descriptionFn(graph.edges[id].weight);
    }
    return id;
}

// ── Signal 1: Rating Handler (Strong Signal) ─────────────────
// Call this whenever thumbs up/down is fired.
// FIXED: Now extracts ALL matched topics, not just the first one.

function graphProcessRating(graph, video, rating) {
    console.log("[Ontology] graphProcessRating called:", {
        videoId: video?.id, channelId: video?.channelId, channelName: video?.channelName,
        matchedTopics: video?.matchedTopics, rating
    });
    // rating: +1 = like, -1 = dislike
    const isLike = rating > 0;
    const nodeDelta = isLike ? 2 : -3;     // Dislikes punish harder
    const edgeDelta = isLike ? 1 : -2;
    const edgeType = isLike ? "CO_LIKED" : "CO_DISLIKED";

    const involvedNodes = [];

    // ── Extract ALL topics from the video (not just the first one) ──
    const topicLabels = [];
    if (video.discoveryTopic) {
        topicLabels.push(video.discoveryTopic.toLowerCase());
    }
    (video.matchedTopics || []).forEach(t => {
        if (t === "all-caps" || t === "punctuation" || t === "viral-spam") return;
        if (t.startsWith("disliked:")) return;
        const normalized = t.trim().toLowerCase();
        if (normalized && !topicLabels.includes(normalized)) {
            topicLabels.push(normalized);
        }
    });

    // Upsert ALL topic nodes
    topicLabels.forEach(label => {
        const nid = graphUpsertNode(graph, label, "Topic", nodeDelta);
        involvedNodes.push(nid);
    });

    // Upsert Channel node (use channelId as stable key)
    const channelLabel = video.channelName || null;
    const channelId = video.channelId || null;

    if (channelId) {
        const nid = graphUpsertNode(graph, channelId, "Channel", nodeDelta);
        // Override label with human name
        if (graph.nodes[nid]) graph.nodes[nid].label = (channelLabel || channelId).toLowerCase();
        involvedNodes.push(nid);
    }

    // Upsert ContentPattern nodes from heuristic matches
    (video.matchedTopics || []).forEach(t => {
        if (t === "all-caps" || t === "punctuation" || t === "viral-spam") {
            const nid = graphUpsertNode(graph, t, "ContentPattern", nodeDelta);
            involvedNodes.push(nid);
        }
    });

    // Create pairwise edges between ALL involved nodes
    for (let i = 0; i < involvedNodes.length; i++) {
        for (let j = i + 1; j < involvedNodes.length; j++) {
            const sId = involvedNodes[i];
            const tId = involvedNodes[j];
            const sLabel = graph.nodes[sId]?.label || sId;
            const tLabel = graph.nodes[tId]?.label || tId;
            graphUpsertEdge(
                graph, sId, tId, edgeType, edgeDelta,
                (w) => `'${sLabel}' and '${tLabel}' co-${isLike ? "liked" : "disliked"} ${Math.abs(w)} time(s)`
            );
        }
    }

    // ── Negative propagation: penalize connected topics on dislike ──
    if (!isLike) {
        involvedNodes.forEach(nid => {
            if (graph.nodes[nid]?.type === "Topic") {
                graphPropagateNegative(graph, nid);
            }
        });
    }

    // Prune every Nth rating (not every single one)
    _ratingsSincePrune++;
    if (_ratingsSincePrune >= RATINGS_PER_PRUNE) {
        graphSmartPrune(graph);
        _ratingsSincePrune = 0;
    }
}

// ── Signal 2: Watch Handler (Weak/Passive Signal) ────────────
// Fires when a video card has been in the viewport for >5 seconds.

function graphProcessWatch(graph, video) {
    const watchDelta = 0.3;  // Weak positive signal
    const edgeType = "CO_VIEWED";

    const involvedNodes = [];

    // Extract all topics
    (video.matchedTopics || []).forEach(t => {
        if (t === "all-caps" || t === "punctuation" || t === "viral-spam") return;
        if (t.startsWith("disliked:")) return;
        const normalized = t.trim().toLowerCase();
        if (normalized) {
            const nid = graphUpsertNode(graph, normalized, "Topic", watchDelta);
            involvedNodes.push(nid);
        }
    });

    // Channel node
    if (video.channelId) {
        const nid = graphUpsertNode(graph, video.channelId, "Channel", watchDelta);
        if (graph.nodes[nid]) {
            graph.nodes[nid].label = (video.channelName || video.channelId).toLowerCase();
        }
        involvedNodes.push(nid);
    }

    // Pairwise CO_VIEWED edges (weaker than ratings)
    for (let i = 0; i < involvedNodes.length; i++) {
        for (let j = i + 1; j < involvedNodes.length; j++) {
            graphUpsertEdge(graph, involvedNodes[i], involvedNodes[j], edgeType, 0.3);
        }
    }
}

// ── Signal 3: Channel Similarity (On-Demand Batch) ───────────
// Runs when Knowledge Graph tab is opened.

function graphBuildChannelSimilarity(graph) {
    const channelNodes = Object.values(graph.nodes).filter(n => n.type === "Channel");

    for (let i = 0; i < channelNodes.length; i++) {
        for (let j = i + 1; j < channelNodes.length; j++) {
            const topicsI = _getConnectedTopics(graph, channelNodes[i].id);
            const topicsJ = _getConnectedTopics(graph, channelNodes[j].id);
            const shared = topicsI.filter(t => topicsJ.includes(t));

            if (shared.length >= MIN_SHARED_TOPICS_FOR_SIMILARITY) {
                graphUpsertEdge(
                    graph, channelNodes[i].id, channelNodes[j].id,
                    "SIMILAR_TO", shared.length * 0.5,
                    (w) => `${shared.length} shared topics (strength: ${w.toFixed(1)})`
                );
            }
        }
    }
}

function _getConnectedTopics(graph, channelNodeId) {
    const topics = [];
    Object.values(graph.edges).forEach(edge => {
        let otherNodeId = null;
        if (edge.source === channelNodeId) otherNodeId = edge.target;
        else if (edge.target === channelNodeId) otherNodeId = edge.source;
        if (otherNodeId && graph.nodes[otherNodeId]?.type === "Topic") {
            topics.push(otherNodeId);
        }
    });
    return topics;
}

// ── Negative Spreading Activation (1-Hop) ────────────────────
// When a user dislikes a topic, connected topics lose weight
// proportional to edge strength × PROPAGATION_FACTOR.
// E.g. disliking "health management" with edge weight 3 to "wellness"
// penalizes "wellness" by 3 × 0.5 = 1.5. Fully reversible.

function graphPropagateNegative(graph, nodeId) {
    Object.values(graph.edges).forEach(edge => {
        let neighborId = null;
        if (edge.source === nodeId) neighborId = edge.target;
        else if (edge.target === nodeId) neighborId = edge.source;
        if (!neighborId) return;

        const neighbor = graph.nodes[neighborId];
        if (!neighbor) return;
        if (neighbor.type !== "Topic") return; // Only propagate to topics

        // Penalty = |edge weight| × propagation factor
        // Strong connections get penalized more (that's the point)
        const penalty = Math.abs(edge.weight) * PROPAGATION_FACTOR;
        neighbor.weight -= penalty;
        neighbor.lastSeen = Date.now();
    });
}

// ── 3-Tier Smart Pruning ─────────────────────────────────────
// Replaces the old simple threshold-only graphPrune().
// Tier 1: Time decay on stale edges
// Tier 2: Kill dead edges/nodes below thresholds
// Tier 3: Orphan cleanup (negative-weight only — unpicked topics are KEPT)
// Tier 4: Hard caps

function graphSmartPrune(graph) {
    const now = Date.now();
    const stats = { decayedEdges: 0, killedEdges: 0, killedNodes: 0, killedOrphans: 0 };

    // ── Tier 1: Time decay on ephemeral edges ──
    Object.values(graph.edges).forEach(edge => {
        const ageMs = now - (edge.lastUpdated || edge.createdAt || now);
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const decayThreshold = edge.type === "CO_VIEWED" ? CO_VIEWED_DECAY_DAYS : CO_LIKED_DECAY_DAYS;

        if (ageDays > decayThreshold) {
            edge.weight = edge.weight > 0
                ? Math.max(0, edge.weight - DECAY_RATE)
                : Math.min(0, edge.weight + DECAY_RATE);
            stats.decayedEdges++;
        }
    });

    // ── Tier 2a: Kill dead edges (|weight| below threshold) ──
    Object.keys(graph.edges).forEach(edgeId => {
        if (Math.abs(graph.edges[edgeId].weight) < EDGE_KILL_THRESHOLD) {
            delete graph.edges[edgeId];
            stats.killedEdges++;
        }
    });

    // ── Tier 2b: Kill ephemeral nodes below weight threshold ──
    Object.keys(graph.nodes).forEach(nodeId => {
        const node = graph.nodes[nodeId];
        if (PERMANENT_NODE_TYPES.has(node.type)) return; // Never prune permanent nodes
        if (node.weight <= NODE_KILL_THRESHOLD) {
            graphDeleteNode(graph, nodeId);
            stats.killedNodes++;
        }
    });

    // ── Tier 3: Kill orphan ephemeral nodes ONLY if negative weight ──
    // IMPORTANT: Unpicked topics (0 edges, positive weight) are NOT orphans.
    // They are waiting to be discovered. Only prune nodes that are both:
    //   (a) disconnected (0 edges), AND
    //   (b) have negative weight (user actively disliked them)
    Object.keys(graph.nodes).forEach(nodeId => {
        const node = graph.nodes[nodeId];
        if (PERMANENT_NODE_TYPES.has(node.type)) return;
        if (node.weight >= 0) return; // Positive/zero weight = keep even without edges

        const hasEdges = Object.values(graph.edges).some(
            e => e.source === nodeId || e.target === nodeId
        );
        if (!hasEdges) {
            delete graph.nodes[nodeId];
            stats.killedOrphans++;
        }
    });

    // ── Tier 4: Hard caps ──
    const nodeEntries = Object.values(graph.nodes);
    if (nodeEntries.length > GRAPH_MAX_NODES) {
        // Evict lowest-weight ephemeral nodes first
        nodeEntries
            .filter(n => !PERMANENT_NODE_TYPES.has(n.type))
            .sort((a, b) => a.weight - b.weight || a.lastSeen - b.lastSeen)
            .slice(0, nodeEntries.length - GRAPH_MAX_NODES)
            .forEach(n => graphDeleteNode(graph, n.id));
    }

    const edgeEntries = Object.values(graph.edges);
    if (edgeEntries.length > GRAPH_MAX_EDGES) {
        edgeEntries
            .sort((a, b) => Math.abs(a.weight) - Math.abs(b.weight))
            .slice(0, edgeEntries.length - GRAPH_MAX_EDGES)
            .forEach(e => delete graph.edges[e.id]);
    }

    graph.lastPruned = now;
    console.log("[Ontology] graphSmartPrune completed:", stats,
        `| nodes: ${Object.keys(graph.nodes).length}, edges: ${Object.keys(graph.edges).length}`);
    return stats;
}

// ── Legacy compat alias — called by Force Prune button ───────
function graphPrune(graph) {
    console.log("[Ontology] graphPrune (Force Prune) triggered");
    return graphSmartPrune(graph);
}

// ── Graph Queries ────────────────────────────────────────────

function graphGetRelatedTopics(graph, label, minEdgeWeight = 1) {
    const nodeId = makeNodeId(label);
    const related = [];
    Object.values(graph.edges).forEach(edge => {
        if (edge.weight < minEdgeWeight) return;
        if (edge.type !== "CO_LIKED") return;
        let otherNodeId = null;
        if (edge.source === nodeId) otherNodeId = edge.target;
        else if (edge.target === nodeId) otherNodeId = edge.source;
        if (otherNodeId && graph.nodes[otherNodeId]?.type === "Topic") {
            related.push({
                label: graph.nodes[otherNodeId].label,
                edgeWeight: edge.weight,
                description: edge.description
            });
        }
    });
    return related.sort((a, b) => b.edgeWeight - a.edgeWeight);
}

function graphGetDislikedChannels(graph, threshold = -3) {
    return Object.values(graph.nodes)
        .filter(n => n.type === "Channel" && n.weight <= threshold)
        .map(n => ({ id: n.label, weight: n.weight })); // label holds channelId
}

// ── Graph-Based Topic Discovery for Smart Feed ───────────────
// Uses 1-hop CO_LIKED edges to find topics connected to recently
// liked topics. Returns topic labels sorted by connection strength.

function graphGetRelatedForDiscovery(graph, recentLikedTopics, maxResults = 5) {
    const candidates = {};
    const likedNodeIds = new Set(recentLikedTopics.map(t => makeNodeId(t)));

    Object.values(graph.edges).forEach(edge => {
        if (edge.type !== "CO_LIKED" || edge.weight < 1) return;

        let seedId = null, neighborId = null;
        if (likedNodeIds.has(edge.source)) { seedId = edge.source; neighborId = edge.target; }
        else if (likedNodeIds.has(edge.target)) { seedId = edge.target; neighborId = edge.source; }
        if (!neighborId) return;

        const neighborNode = graph.nodes[neighborId];
        if (!neighborNode || neighborNode.type !== "Topic") return;
        if (likedNodeIds.has(neighborId)) return; // Skip already-liked topics

        if (!candidates[neighborId]) {
            candidates[neighborId] = { label: neighborNode.label, score: 0 };
        }
        candidates[neighborId].score += edge.weight;
    });

    return Object.values(candidates)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(c => c.label);
}

// ── Graph-Aware Video Scoring ────────────────────────────────

function graphScoreVideo(graph, video) {
    let bonus = 0;

    // Score ALL matched topics (not just the first one)
    const topicLabels = [];
    if (video.discoveryTopic) topicLabels.push(video.discoveryTopic);
    (video.matchedTopics || []).forEach(t => {
        if (t !== "all-caps" && t !== "punctuation" && t !== "viral-spam" && !t.startsWith("disliked:")) {
            topicLabels.push(t);
        }
    });

    topicLabels.forEach(label => {
        const nid = makeNodeId(label);
        const node = graph.nodes[nid];
        if (node) bonus += Math.min(node.weight, 10); // cap bonus contribution
    });

    const channelId = video.channelId;
    if (channelId) {
        const nid = makeNodeId(channelId);
        const node = graph.nodes[nid];
        if (node) bonus += Math.min(node.weight, 10);
    }
    return bonus;
}
