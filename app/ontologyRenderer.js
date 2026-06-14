// ============================================================
//  Wallgarden Ontology Canvas Renderer
//  Native HTML5 Canvas Force-Directed Graph Engine
// ============================================================

const TYPE_COLORS = {
    Topic: "#3b82f6",
    Channel: "#10b981",
    ContentPattern: "#8b5cf6",
    default: "#64748b"
};

function drawRoundedRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}

function initLayout(nodes, edges, width, height) {
    const centerX = width / 2;
    const centerY = height / 2;

    const degreeMap = {};
    nodes.forEach(node => { degreeMap[node.id] = 0; });
    edges.forEach(edge => {
        if (degreeMap[edge.source] !== undefined) degreeMap[edge.source]++;
        if (degreeMap[edge.target] !== undefined) degreeMap[edge.target]++;
    });

    const typeGroups = {};
    nodes.forEach(node => {
        const nodeType = node.type || 'default';
        if (!typeGroups[nodeType]) typeGroups[nodeType] = [];
        typeGroups[nodeType].push(node);
    });

    const typeKeys = Object.keys(typeGroups);
    const typeAngleMap = {};
    typeKeys.forEach((type, index) => {
        typeAngleMap[type] = (2 * Math.PI * index) / Math.max(typeKeys.length, 1);
    });

    const clusterRadius = Math.min(width, height) * 0.15;
    const jitterAmount = Math.min(width, height) * 0.08;

    return nodes.map(node => {
        const nodeType = node.type || 'default';
        const angle = typeAngleMap[nodeType];
        const groupCenterX = centerX + clusterRadius * Math.cos(angle);
        const groupCenterY = centerY + clusterRadius * Math.sin(angle);
        const degreeCount = degreeMap[node.id] || 0;
        
        let act = node.weight > 0 ? Math.min(node.weight, 20) / 20 : 0;

        return {
            ...node,
            x: groupCenterX + (Math.random() - 0.5) * jitterAmount,
            y: groupCenterY + (Math.random() - 0.5) * jitterAmount,
            vx: 0,
            vy: 0,
            radius: Math.max(5, 6 + (act * 16) + Math.min(degreeCount, 10) * 0.8),
            _degree: degreeCount,
            activation: act,
            _addedAt: node.createdAt || Date.now()
        };
    });
}

function physicsTick(nodes, edges, nodeMapById, alpha) {
    if (nodes.length === 0) return;

    const nodeCount = nodes.length;
    const edgeCount = edges.length;

    const repulsion = 1500 + nodeCount * 12;
    const idealLength = 70 + Math.min(nodeCount, 200) * 0.4;
    const attraction = 0.02 + Math.min(edgeCount / Math.max(nodeCount, 1), 2) * 0.008;
    const centerGravity = 0.0005;
    const groupGravity = 0.0025;
    const clusterOffsetGravity = 0.0004; // Weak pull toward fixed type regions
    const damping = 0.82;
    const maxVelocity = 15;

    let centerOfMassX = 0;
    let centerOfMassY = 0;
    nodes.forEach(node => { centerOfMassX += node.x; centerOfMassY += node.y; });
    centerOfMassX /= nodeCount;
    centerOfMassY /= nodeCount;

    const typeCentroids = {};
    const typeCounts = {};

    nodes.forEach(node => {
        const nodeType = node.type || 'default';
        if (!typeCentroids[nodeType]) {
            typeCentroids[nodeType] = { x: 0, y: 0 };
            typeCounts[nodeType] = 0;
        }
        typeCentroids[nodeType].x += node.x;
        typeCentroids[nodeType].y += node.y;
        typeCounts[nodeType]++;
    });

    for (const nodeType in typeCentroids) {
        typeCentroids[nodeType].x /= typeCounts[nodeType];
        typeCentroids[nodeType].y /= typeCounts[nodeType];
    }

    if (nodeCount <= 500) {
        for (let i = 0; i < nodeCount; i++) {
            for (let j = i + 1; j < nodeCount; j++) {
                const deltaX = nodes[j].x - nodes[i].x;
                const deltaY = nodes[j].y - nodes[i].y;
                let distanceSquared = deltaX * deltaX + deltaY * deltaY;
                if (distanceSquared < 1) distanceSquared = 1;
                const distance = Math.sqrt(distanceSquared);
                let force = (repulsion / distanceSquared) * alpha;
                force = Math.min(force, 50);
                const forceX = (deltaX / distance) * force;
                const forceY = (deltaY / distance) * force;
                nodes[i].vx -= forceX;
                nodes[i].vy -= forceY;
                nodes[j].vx += forceX;
                nodes[j].vy += forceY;
            }
        }
    }

    for (let i = 0; i < nodeCount; i++) {
        for (let j = i + 1; j < nodeCount; j++) {
            const nodeA = nodes[i];
            const nodeB = nodes[j];
            const deltaX = nodeB.x - nodeA.x;
            const deltaY = nodeB.y - nodeA.y;
            const distanceSquared = deltaX * deltaX + deltaY * deltaY;
            const minDist = nodeA.radius + nodeB.radius + 15;
            if (distanceSquared < minDist * minDist) {
                const distance = Math.sqrt(distanceSquared) || 1;
                const overlap = minDist - distance;
                const pushX = (deltaX / distance) * overlap * 0.4 * alpha;
                const pushY = (deltaY / distance) * overlap * 0.4 * alpha;

                if (!nodeA._dragging) {
                    nodeA.vx -= pushX;
                    nodeA.vy -= pushY;
                }
                if (!nodeB._dragging) {
                    nodeB.vx += pushX;
                    nodeB.vy += pushY;
                }
            }
        }
    }

    edges.forEach(edge => {
        const sourceNode = nodeMapById[edge.source];
        const targetNode = nodeMapById[edge.target];
        if (!sourceNode || !targetNode) return;
        const deltaX = targetNode.x - sourceNode.x;
        const deltaY = targetNode.y - sourceNode.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1;
        const edgeWeight = edge.weight || 0.5;
        const springStrength = attraction * edgeWeight * edgeWeight * 4;
        let force = springStrength * (distance - idealLength) * alpha;
        force = Math.max(-40, Math.min(40, force));
        const forceX = (deltaX / distance) * force;
        const forceY = (deltaY / distance) * force;
        sourceNode.vx += forceX;
        sourceNode.vy += forceY;
        targetNode.vx -= forceX;
        targetNode.vy -= forceY;
    });

    nodes.forEach(node => {
        if (node._dragging) return;
        const deltaX = centerOfMassX - node.x;
        const deltaY = centerOfMassY - node.y;
        node.vx += deltaX * centerGravity * alpha;
        node.vy += deltaY * centerGravity * alpha;
    });

    nodes.forEach(node => {
        if (node._dragging) return;
        const nodeType = node.type || 'default';
        const centroid = typeCentroids[nodeType];
        if (!centroid) return;
        const deltaX = centroid.x - node.x;
        const deltaY = centroid.y - node.y;
        node.vx += deltaX * groupGravity * alpha;
        node.vy += deltaY * groupGravity * alpha;
    });

    // ── Fixed-offset type clustering ──
    // Gives each node type a gentle pull toward a fixed region of the canvas.
    // This breaks the initial sunflower spiral symmetry so types separate visually.
    const TYPE_CLUSTER_OFFSETS = {
        "Topic":          { x: -0.2, y: -0.15 },   // Upper-left
        "Channel":        { x:  0.25, y: -0.1 },    // Upper-right
        "ContentPattern": { x:  0.0, y:  0.25 },    // Bottom center
    };
    nodes.forEach(node => {
        if (node._dragging) return;
        const offset = TYPE_CLUSTER_OFFSETS[node.type];
        if (!offset) return;
        const targetX = centerOfMassX + offset.x * 600;
        const targetY = centerOfMassY + offset.y * 600;
        node.vx += (targetX - node.x) * clusterOffsetGravity * alpha;
        node.vy += (targetY - node.y) * clusterOffsetGravity * alpha;
    });

    nodes.forEach(node => {
        if (node._dragging) return;
        node.vx *= damping;
        node.vy *= damping;
        const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
        if (speed > maxVelocity) {
            node.vx = (node.vx / speed) * maxVelocity;
            node.vy = (node.vy / speed) * maxVelocity;
        }
        node.x += node.vx;
        node.y += node.vy;
    });
}

class OntologyGraphCanvas {
    constructor(container, onNodeSelected) {
        this.container = container;
        this.onNodeSelected = onNodeSelected;
        this.canvas = document.createElement('canvas');
        this.canvas.style.display = 'block';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.background = '#0a0f1a';
        
        // Remove existing children and append canvas
        this.container.innerHTML = '';
        this.container.appendChild(this.canvas);
        
        this.ctx = this.canvas.getContext('2d');
        this.animationFrameId = null;
        
        this.nodes = [];
        this.edges = [];
        this.nodeMapById = {};
        
        this.transform = { scale: 1, offsetX: 0, offsetY: 0 };
        this.alpha = 1.0;
        
        this.hoveredNodeId = null;
        this.selectedNodeId = null;
        
        this.dragState = { dragging: false, nodeId: null, isPan: false, panStartX: 0, panStartY: 0 };
        
        this.handleResize = this.handleResize.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleWheel = this.handleWheel.bind(this);
        this.render = this.render.bind(this);
        
        this.initEvents();
        this.handleResize();
    }
    
    initEvents() {
        const ro = new ResizeObserver(this.handleResize);
        ro.observe(this.container);
        this.ro = ro;
        
        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('mouseleave', this.handleMouseUp);
        this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    }
    
    destroy() {
        if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
        if (this.ro) this.ro.disconnect();
        this.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.canvas.removeEventListener('mouseleave', this.handleMouseUp);
        this.canvas.removeEventListener('wheel', this.handleWheel);
        this.container.innerHTML = '';
    }
    
    handleResize() {
        this.canvas.width = this.container.clientWidth || 800;
        this.canvas.height = this.container.clientHeight || 600;
        if (this.nodes.length === 0) {
            this.transform.offsetX = this.canvas.width / 2;
            this.transform.offsetY = this.canvas.height / 2;
        }
    }
    
    setData(nodesData, edgesData) {
        const canvasWidth = this.canvas.width;
        const canvasHeight = this.canvas.height;
        
        const newLayoutNodes = initLayout(nodesData, edgesData, canvasWidth, canvasHeight);
        this.nodes = newLayoutNodes;
        this.edges = edgesData.map(e => ({
            ...e,
            _addedAt: e.createdAt || Date.now()
        }));
        
        this.nodeMapById = {};
        this.nodes.forEach(n => this.nodeMapById[n.id] = n);
        
        // Settle quickly
        for (let i = 0; i < 240; i++) {
            const preAlpha = 1.0 - (i / 240) * 0.8;
            physicsTick(this.nodes, this.edges, this.nodeMapById, preAlpha);
        }
        
        this.alpha = 0.4; // Cool down
        
        // Recenter
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        this.nodes.forEach(node => {
            minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
            minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
        });
        const graphWidth = Math.max(maxX - minX, 1) + 120;
        const graphHeight = Math.max(maxY - minY, 1) + 120;
        const scale = Math.min(canvasWidth / graphWidth, canvasHeight / graphHeight, 2.0);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        
        this.transform = {
            scale,
            offsetX: canvasWidth / 2 - centerX * scale,
            offsetY: canvasHeight / 2 - centerY * scale,
        };
        
        if (!this.animationFrameId) {
            this.render();
        }
    }
    
    updateData(nodesData, edgesData) {
        // Find new nodes
        const existingIds = new Set(this.nodes.map(n => n.id));
        const newNodes = nodesData.filter(n => !existingIds.has(n.id));
        
        const degreeMap = {};
        nodesData.forEach(n => { degreeMap[n.id] = 0; });
        edgesData.forEach(e => {
            if (degreeMap[e.source] !== undefined) degreeMap[e.source]++;
            if (degreeMap[e.target] !== undefined) degreeMap[e.target]++;
        });
        
        newNodes.forEach(node => {
            let startX = this.canvas.width / 2;
            let startY = this.canvas.height / 2;
            const connectedEdge = edgesData.find(e => e.source === node.id || e.target === node.id);
            if (connectedEdge) {
                const neighborId = connectedEdge.source === node.id ? connectedEdge.target : connectedEdge.source;
                const neighborNode = this.nodes.find(en => en.id === neighborId);
                if (neighborNode) {
                    startX = neighborNode.x + (Math.random() - 0.5) * 60;
                    startY = neighborNode.y + (Math.random() - 0.5) * 60;
                }
            }
            
            const degreeCount = degreeMap[node.id] || 0;
            let act = node.weight > 0 ? Math.min(node.weight, 20) / 20 : 0;
            const physicsNode = {
                ...node,
                x: startX,
                y: startY,
                vx: 0,
                vy: 0,
                radius: Math.max(5, 6 + (act * 16) + Math.min(degreeCount, 10) * 0.8),
                _degree: degreeCount,
                activation: act,
                _addedAt: Date.now()
            };
            this.nodes.push(physicsNode);
            this.nodeMapById[physicsNode.id] = physicsNode;
        });
        
        // Remove old nodes
        const incomingIds = new Set(nodesData.map(n => n.id));
        this.nodes = this.nodes.filter(n => incomingIds.has(n.id));
        
        // Update existing nodes properties
        this.nodes.forEach(pn => {
            const incomingNode = nodesData.find(n => n.id === pn.id);
            if (incomingNode) {
                pn.weight = incomingNode.weight;
                pn.activation = incomingNode.weight > 0 ? Math.min(incomingNode.weight, 20) / 20 : 0;
                pn._degree = degreeMap[pn.id] || 0;
                pn.radius = Math.max(5, 6 + (pn.activation * 16) + Math.min(pn._degree, 10) * 0.8);
            }
        });
        
        this.edges = edgesData.map(e => ({
            ...e,
            _addedAt: e.createdAt || Date.now()
        }));
        
        this.nodeMapById = {};
        this.nodes.forEach(n => this.nodeMapById[n.id] = n);
        
        if (newNodes.length > 0) {
            this.alpha = Math.max(this.alpha, 0.5);
        } else {
            this.alpha = Math.max(this.alpha, 0.1);
        }
    }
    
    screenToWorld(screenX, screenY) {
        return {
            x: (screenX - this.transform.offsetX) / this.transform.scale,
            y: (screenY - this.transform.offsetY) / this.transform.scale
        };
    }
    
    findNodeAt(worldX, worldY) {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            const deltaX = worldX - node.x;
            const deltaY = worldY - node.y;
            if (deltaX * deltaX + deltaY * deltaY <= (node.radius + 4) * (node.radius + 4)) return node;
        }
        return null;
    }
    
    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const { x: worldX, y: worldY } = this.screenToWorld(screenX, screenY);
        
        const node = this.findNodeAt(worldX, worldY);
        if (node) {
            this.dragState = { dragging: true, nodeId: node.id, isPan: false, panStartX: 0, panStartY: 0 };
            node._dragging = true;
            this.selectedNodeId = node.id;
            if (this.onNodeSelected) this.onNodeSelected(node);
            this.alpha = Math.max(this.alpha, 0.15);
            this.canvas.style.cursor = 'grabbing';
        } else {
            this.dragState = {
                dragging: false, nodeId: null, isPan: true,
                panStartX: screenX, panStartY: screenY,
                origOx: this.transform.offsetX, origOy: this.transform.offsetY
            };
            this.selectedNodeId = null;
            if (this.onNodeSelected) this.onNodeSelected(null);
        }
    }
    
    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const { x: worldX, y: worldY } = this.screenToWorld(screenX, screenY);
        
        if (this.dragState.dragging && this.dragState.nodeId) {
            const node = this.nodeMapById[this.dragState.nodeId];
            if (node) {
                node.x = worldX;
                node.y = worldY;
                node.vx = 0;
                node.vy = 0;
            }
            this.alpha = Math.max(this.alpha, 0.08);
            return;
        }
        
        if (this.dragState.isPan && this.dragState.origOx !== undefined) {
            this.transform.offsetX = this.dragState.origOx + (screenX - this.dragState.panStartX);
            this.transform.offsetY = this.dragState.origOy + (screenY - this.dragState.panStartY);
            return;
        }
        
        const node = this.findNodeAt(worldX, worldY);
        this.hoveredNodeId = node ? node.id : null;
        if (!this.dragState.dragging && !this.dragState.isPan) {
            this.canvas.style.cursor = node ? 'pointer' : 'default';
        }
    }
    
    handleMouseUp(e) {
        if (this.dragState.nodeId) {
            const node = this.nodeMapById[this.dragState.nodeId];
            if (node) node._dragging = false;
        }
        this.dragState = { dragging: false, nodeId: null, isPan: false, panStartX: 0, panStartY: 0 };
        this.canvas.style.cursor = 'default';
    }
    
    handleWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const newScale = Math.max(0.05, Math.min(10, this.transform.scale * zoomFactor));
        this.transform.offsetX = mouseX - ((mouseX - this.transform.offsetX) / this.transform.scale) * newScale;
        this.transform.offsetY = mouseY - ((mouseY - this.transform.offsetY) / this.transform.scale) * newScale;
        this.transform.scale = newScale;
    }
    
    render() {
        if (this.alpha > 0.005 && this.nodes.length > 0) {
            physicsTick(this.nodes, this.edges, this.nodeMapById, this.alpha);
            this.alpha *= 0.993;
        }
        
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.save();
        this.ctx.setTransform(this.transform.scale, 0, 0, this.transform.scale, this.transform.offsetX, this.transform.offsetY);
        
        // Draw grid
        const gridSize = 40;
        const startX = -this.transform.offsetX / this.transform.scale - 200;
        const startY = -this.transform.offsetY / this.transform.scale - 200;
        const endX = (this.canvas.width - this.transform.offsetX) / this.transform.scale + 200;
        const endY = (this.canvas.height - this.transform.offsetY) / this.transform.scale + 200;
        
        if (this.transform.scale > 0.3) {
            this.ctx.fillStyle = 'rgba(51, 65, 85, 0.12)';
            for (let x = Math.floor(startX / gridSize) * gridSize; x < endX; x += gridSize) {
                for (let y = Math.floor(startY / gridSize) * gridSize; y < endY; y += gridSize) {
                    this.ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
                }
            }
        }
        
        const edgeNow = Date.now();
        const EDGE_ANIM_DURATION = 400;
        
        this.edges.forEach(edge => {
            const sourceNode = this.nodeMapById[edge.source];
            const targetNode = this.nodeMapById[edge.target];
            if (!sourceNode || !targetNode) return;
            
            const deltaX = targetNode.x - sourceNode.x;
            const deltaY = targetNode.y - sourceNode.y;
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            if (distance < 1) return;
            
            const edgeWeight = Math.max(0.1, Math.min(10, edge.weight)) / 10;
            const targetRadius = targetNode.radius || 8;
            const sourceRadius = sourceNode.radius || 8;
            const fullTargetX = targetNode.x - (deltaX / distance) * targetRadius;
            const fullTargetY = targetNode.y - (deltaY / distance) * targetRadius;
            const computedSourceX = sourceNode.x + (deltaX / distance) * sourceRadius;
            const computedSourceY = sourceNode.y + (deltaY / distance) * sourceRadius;
            
            let edgeProgress = 1.0;
            let edgeAlpha = 1.0;
            if (edge._addedAt) {
                const elapsed = edgeNow - edge._addedAt;
                if (elapsed < EDGE_ANIM_DURATION) {
                    edgeProgress = elapsed / EDGE_ANIM_DURATION;
                    edgeAlpha = edgeProgress;
                }
            }
            
            const targetX = computedSourceX + (fullTargetX - computedSourceX) * edgeProgress;
            const targetY = computedSourceY + (fullTargetY - computedSourceY) * edgeProgress;
            
            const baseOpacity = 0.1 + edgeWeight * 0.5;
            this.ctx.globalAlpha = edgeAlpha;
            this.ctx.beginPath();
            this.ctx.moveTo(computedSourceX, computedSourceY);
            this.ctx.lineTo(targetX, targetY);
            this.ctx.strokeStyle = `rgba(120, 140, 165, ${baseOpacity})`;
            this.ctx.lineWidth = 0.3 + edgeWeight * 2.5;
            this.ctx.stroke();
            
            if (edgeProgress > 0.85 && distance > 30) {
                const arrowLength = 4 + edgeWeight * 4;
                const arrowAngle = Math.PI / 7;
                const angle = Math.atan2(deltaY, deltaX);
                this.ctx.beginPath();
                this.ctx.moveTo(targetX, targetY);
                this.ctx.lineTo(targetX - arrowLength * Math.cos(angle - arrowAngle), targetY - arrowLength * Math.sin(angle - arrowAngle));
                this.ctx.lineTo(targetX - arrowLength * Math.cos(angle + arrowAngle), targetY - arrowLength * Math.sin(angle + arrowAngle));
                this.ctx.closePath();
                this.ctx.fillStyle = `rgba(120, 140, 165, ${baseOpacity * 0.8})`;
                this.ctx.fill();
            }
            this.ctx.globalAlpha = 1.0;
        });
        
        const now = Date.now();
        const SPRING_DURATION = 600;
        
        this.nodes.forEach(node => {
            const nodeType = node.type || 'default';
            const nodeColor = TYPE_COLORS[nodeType] || TYPE_COLORS.default;
            const isHovered = this.hoveredNodeId === node.id;
            const isSelected = this.selectedNodeId === node.id;
            const baseRadius = node.radius || 8;
            
            let computedRadius = baseRadius;
            let nodeAlpha = 1.0;
            if (node._addedAt) {
                const elapsed = now - node._addedAt;
                if (elapsed < SPRING_DURATION) {
                    const progressRatio = elapsed / SPRING_DURATION;
                    const springValue = 1 - Math.exp(-6 * progressRatio) * Math.cos(8 * progressRatio);
                    computedRadius = baseRadius * Math.max(0, springValue);
                    nodeAlpha = Math.min(1, progressRatio * 2);
                }
            }
            if (computedRadius < 0.5) return;
            
            if (((node.activation || 0) > 0.3 || isSelected) && this.transform.scale > 0.3) {
                const glowRadius = computedRadius + 6 + (node.activation || 0) * 8;
                const glowAlpha = 0.04 + (node.activation || 0) * 0.08;
                this.ctx.beginPath();
                this.ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
                this.ctx.fillStyle = `rgba(100, 180, 255, ${glowAlpha})`;
                this.ctx.fill();
            }
            
            this.ctx.globalAlpha = nodeAlpha;
            this.ctx.beginPath();
            this.ctx.arc(node.x, node.y, computedRadius, 0, Math.PI * 2);
            this.ctx.fillStyle = nodeColor;
            this.ctx.fill();
            
            if (computedRadius > 4) {
                this.ctx.beginPath();
                this.ctx.arc(node.x - computedRadius * 0.2, node.y - computedRadius * 0.2, computedRadius * 0.4, 0, Math.PI * 2);
                this.ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
                this.ctx.fill();
            }
            this.ctx.globalAlpha = 1.0;
            
            if ((node.activation || 0) > 0.5) {
                const pulse = (Math.sin(now / 200) + 1) / 2;
                this.ctx.beginPath();
                this.ctx.arc(node.x, node.y, computedRadius + 3 + pulse * 5, 0, Math.PI * 2);
                this.ctx.strokeStyle = `rgba(255, 255, 255, ${0.3 - pulse * 0.3})`;
                this.ctx.lineWidth = 1.5;
                this.ctx.stroke();
            }
            
            if (isSelected) {
                this.ctx.beginPath();
                this.ctx.arc(node.x, node.y, computedRadius + 2, 0, Math.PI * 2);
                this.ctx.lineWidth = 2.5;
                this.ctx.strokeStyle = '#ffffff';
                this.ctx.stroke();
            } else if (isHovered) {
                this.ctx.beginPath();
                this.ctx.arc(node.x, node.y, computedRadius + 2, 0, Math.PI * 2);
                this.ctx.lineWidth = 1.5;
                this.ctx.strokeStyle = 'rgba(255,255,255,0.6)';
                this.ctx.stroke();
            }
            
            const isImportant = (node._degree || 0) > 4 || (node.activation || 0) > 0.3;
            const isSemiImportant = (node._degree || 0) > 1 || (node.activation || 0) > 0.05;
            const shouldShowLabel = isSelected || isHovered || (this.transform.scale > 1.2) || (this.transform.scale > 0.8 && isSemiImportant) || (this.transform.scale > 0.5 && isImportant) || ((node._degree || 0) > 6 || (node.activation || 0) > 0.5);
            
            if (shouldShowLabel) {
                const labelText = node.label || node.id;
                const fontSize = isSelected ? 11 : Math.max(8, Math.min(10, 8 + (node._degree || 0) * 0.25));
                this.ctx.font = isSelected || isHovered ? `bold ${fontSize}px Inter` : `${fontSize}px Inter`;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                
                const textWidth = this.ctx.measureText(labelText).width;
                const padX = 6, padY = 4;
                const rectWidth = textWidth + padX * 2, rectHeight = fontSize + padY * 2;
                const rectX = node.x - rectWidth / 2, rectY = node.y + computedRadius + 6;
                
                const baseAlpha = isHovered || isSelected ? 1.0 : Math.min(1.0, 0.45 + (node._degree || 0) * 0.08);
                this.ctx.globalAlpha = baseAlpha;
                
                drawRoundedRect(this.ctx, rectX, rectY, rectWidth, rectHeight, 4);
                this.ctx.fillStyle = isSelected ? 'rgba(15, 23, 42, 0.95)' : isHovered ? 'rgba(30, 41, 59, 0.92)' : 'rgba(10, 15, 26, 0.78)';
                this.ctx.fill();
                
                this.ctx.strokeStyle = isSelected ? '#ffffff' : isHovered ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.08)';
                this.ctx.lineWidth = isSelected ? 1.5 : 1;
                this.ctx.stroke();
                
                this.ctx.fillStyle = isSelected ? '#ffffff' : isHovered ? '#f8fafc' : '#cbd5e1';
                this.ctx.fillText(labelText, node.x, rectY + rectHeight / 2);
                
                this.ctx.globalAlpha = 1.0;
                this.ctx.textBaseline = 'alphabetic';
            }
        });
        
        this.ctx.restore();
        this.animationFrameId = requestAnimationFrame(this.render);
    }
}
