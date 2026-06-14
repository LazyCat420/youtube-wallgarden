// ============================================================
//  Wallgarden Ontology Engine
//  Self-pruning knowledge graph for content preferences
// ============================================================

const GRAPH_PRUNE_THRESHOLD = -8;       // Nodes below this weight are deleted
const GRAPH_EDGE_PRUNE_THRESHOLD = -5;  // Edges below this weight are deleted
const GRAPH_MAX_NODES = 10000;            // Hard cap to prevent bloat
const GRAPH_MAX_EDGES = 20000;            // Hard cap

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
    Object.values(graph.clusters).forEach(members => {
        const idx = members.indexOf(nodeId);
        if (idx > -1) members.splice(idx, 1);
    });
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

// ── Main Rating Handler ──────────────────────────────────────
// Call this whenever thumbs up/down is fired

function graphProcessRating(graph, video, rating) {
    // rating: +1 = like, -1 = dislike
    const isLike = rating > 0;
    const nodeDelta = isLike ? 2 : -3;     // Dislikes punish harder
    const edgeDelta = isLike ? 1 : -2;
    const edgeType = isLike ? "CO_LIKED" : "CO_DISLIKED";

    // Extract nodes from the video
    const topicLabel = video.discoveryTopic ||
        (video.matchedTopics || []).find(t =>
            t !== "all-caps" && t !== "punctuation" && !t.startsWith("disliked:")
        ) || null;
    const channelLabel = video.channelName || null;
    const channelId = video.channelId || null;

    const involvedNodes = [];

    // Upsert Topic node
    if (topicLabel) {
        const nid = graphUpsertNode(graph, topicLabel, "Topic", nodeDelta);
        involvedNodes.push(nid);
    }

    // Upsert Channel node (use channelId as label so it's stable)
    if (channelId) {
        const nid = graphUpsertNode(graph, channelId, "Channel", nodeDelta);
        // Override label with human name
        if (graph.nodes[nid]) graph.nodes[nid].label = (channelLabel || channelId).toLowerCase();
        involvedNodes.push(nid);
    }

    // Upsert ContentPattern nodes from matchedTopics heuristics
    (video.matchedTopics || []).forEach(t => {
        if (t === "all-caps" || t === "punctuation" || t === "viral-spam") {
            const nid = graphUpsertNode(graph, t, "ContentPattern", nodeDelta);
            involvedNodes.push(nid);
        }
    });

    // Create pairwise edges between all involved nodes
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

    // Prune after every rating
    graphPrune(graph);
}

// ── Pruning Logic (prevents bloat) ──────────────────────────

function graphPrune(graph) {
    // 1. Delete nodes below weight threshold
    Object.keys(graph.nodes).forEach(nodeId => {
        if (graph.nodes[nodeId].weight <= GRAPH_PRUNE_THRESHOLD) {
            graphDeleteNode(graph, nodeId);
        }
    });

    // 2. Delete edges below threshold
    Object.keys(graph.edges).forEach(edgeId => {
        if (graph.edges[edgeId].weight <= GRAPH_EDGE_PRUNE_THRESHOLD) {
            delete graph.edges[edgeId];
        }
    });

    // 3. Hard-cap: if over max nodes, evict lowest-weight nodes (oldest first as tiebreak)
    const nodeEntries = Object.values(graph.nodes);
    if (nodeEntries.length > GRAPH_MAX_NODES) {
        nodeEntries
            .sort((a, b) => a.weight - b.weight || a.lastSeen - b.lastSeen)
            .slice(0, nodeEntries.length - GRAPH_MAX_NODES)
            .forEach(n => graphDeleteNode(graph, n.id));
    }

    // 4. Hard-cap edges
    const edgeEntries = Object.values(graph.edges);
    if (edgeEntries.length > GRAPH_MAX_EDGES) {
        edgeEntries
            .sort((a, b) => a.weight - b.weight)
            .slice(0, edgeEntries.length - GRAPH_MAX_EDGES)
            .forEach(e => delete graph.edges[e.id]);
    }
}

// ── Graph Query: What topics are related to a given topic? ───

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

// ── Graph Query: Get blocked channel node IDs ─────────────────

function graphGetDislikedChannels(graph, threshold = -3) {
    return Object.values(graph.nodes)
        .filter(n => n.type === "Channel" && n.weight <= threshold)
        .map(n => ({ id: n.label, weight: n.weight })); // label holds channelId
}

// ── Graph-Aware Scoring (replaces/augments getScoreAndMatches) ─

function graphScoreVideo(graph, video) {
    let bonus = 0;
    const topicLabel = video.discoveryTopic ||
        (video.matchedTopics || []).find(t =>
            t !== "all-caps" && !t.startsWith("disliked:")
        ) || null;
    const channelId = video.channelId;

    if (topicLabel) {
        const nid = makeNodeId(topicLabel);
        const node = graph.nodes[nid];
        if (node) bonus += Math.min(node.weight, 10); // cap bonus contribution
    }
    if (channelId) {
        const nid = makeNodeId(channelId);
        const node = graph.nodes[nid];
        if (node) bonus += Math.min(node.weight, 10);
    }
    return bonus;
}
