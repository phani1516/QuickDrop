/* ====================================================
   QuickDrop — WebSocket Signaling Server
   ====================================================
   Pure signaling + presence. No file storage. No DB.
   Files travel peer-to-peer via WebRTC data channels.
   ==================================================== */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');
const path = require('path');
const os = require('os');

// ---- Express for static assets only ----
const app = express();
const server = http.createServer(app);

app.use(compression({
    filter: (req, res) => {
        if (req.path.match(/\.(png|jpg|jpeg|gif|ico|webp|woff2?)$/)) return false;
        return compression.filter(req, res);
    }
}));

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
}));

// ---- WebSocket Signaling Server ----
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Configuration ----
const CONFIG = {
    HEARTBEAT_INTERVAL: 15000,   // ms between heartbeat checks
    STALE_TIMEOUT: 30000,        // ms before marking session stale
    MAX_CONNECTIONS_PER_IP: 10,
    MAX_ROOM_SIZE: 10,
};

// ---- In-Memory Session Store ----
const sessions = new Map();          // sessionId → SessionInfo
const ipConnectionCount = new Map(); // ip → count

// ---- Codename Generation (Snapdrop-style) ----
const adjectives = [
    'Anonymous', 'Brave', 'Calm', 'Daring', 'Eager', 'Fierce',
    'Gentle', 'Happy', 'Icy', 'Jolly', 'Kind', 'Lively',
    'Mighty', 'Noble', 'Ocean', 'Proud', 'Quick', 'Royal',
    'Silent', 'Thunder', 'Ultra', 'Vivid', 'Wild', 'Young', 'Zen'
];
const animals = [
    'Falcon', 'Fox', 'Hawk', 'Lion', 'Otter', 'Panda',
    'Raven', 'Shark', 'Tiger', 'Wolf', 'Bear', 'Eagle',
    'Dolphin', 'Lynx', 'Koala', 'Owl', 'Panther', 'Swan',
    'Jaguar', 'Phoenix'
];

function generateCodename() {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return `${adj} ${animal}`;
}

// ---- IP / Subnet Utilities ----
function extractIP(request) {
    let ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || request.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function getSubnet(ip) {
    if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return 'localhost';
    const parts = ip.split('.');
    if (parts.length === 4) return parts.slice(0, 3).join('.');
    return 'local';                     // IPv6 fallback — group everyone
}

// ---- Discovery Scope ----
function areInSameScope(a, b) {
    if (a.roomCode && b.roomCode && a.roomCode === b.roomCode) return true;
    if (!a.roomCode && !b.roomCode && a.subnet === b.subnet) return true;
    return false;
}

function getDevicesInScope(session) {
    const result = [];
    for (const [id, s] of sessions) {
        if (id === session.sessionId) continue;
        if (areInSameScope(session, s)) {
            result.push({
                sessionId: s.sessionId,
                codename: s.codename,
                deviceType: s.deviceType,
                platform: s.platform,
            });
        }
    }
    return result;
}

function broadcastDeviceLists() {
    for (const [, session] of sessions) {
        send(session.ws, { type: 'device-list', devices: getDevicesInScope(session) });
    }
}

// ---- Helpers ----
function send(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    const count = (ipConnectionCount.get(session.ip) || 1) - 1;
    if (count <= 0) ipConnectionCount.delete(session.ip);
    else ipConnectionCount.set(session.ip, count);
    sessions.delete(sessionId);
    broadcastDeviceLists();
}

// ---- Heartbeat / Stale Cleanup ----
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastSeen > CONFIG.STALE_TIMEOUT) {
            session.ws.terminate();
            removeSession(id);
        }
    }
}, CONFIG.HEARTBEAT_INTERVAL);

// ---- Connection Handler ----
wss.on('connection', (ws, request) => {
    const ip = extractIP(request);
    const currentCount = ipConnectionCount.get(ip) || 0;

    if (currentCount >= CONFIG.MAX_CONNECTIONS_PER_IP) {
        send(ws, { type: 'error', message: 'Too many connections from this IP.' });
        ws.close();
        return;
    }
    ipConnectionCount.set(ip, currentCount + 1);

    const subnet = getSubnet(ip);
    let sessionId = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // -- Registration --
        if (msg.type === 'register') {
            sessionId = uuidv4();
            const codename = generateCodename();
            sessions.set(sessionId, {
                ws, sessionId, codename,
                deviceType: msg.deviceType || 'desktop',
                platform: msg.platform || 'other',
                ip, subnet,
                roomCode: null,
                lastSeen: Date.now(),
            });
            send(ws, { type: 'registered', sessionId, codename });
            broadcastDeviceLists();
            return;
        }

        // Guard: must be registered for all other messages
        if (!sessionId || !sessions.has(sessionId)) return;
        const session = sessions.get(sessionId);
        session.lastSeen = Date.now();

        switch (msg.type) {

            // -- WebRTC Signaling Relay --
            case 'signal': {
                const target = sessions.get(msg.targetId);
                if (target && areInSameScope(session, target)) {
                    send(target.ws, {
                        type: 'signal',
                        senderId: sessionId,
                        signalType: msg.signalType,
                        data: msg.data,
                    });
                }
                break;
            }

            // -- File Transfer Offer (metadata only) --
            case 'file-offer': {
                const target = sessions.get(msg.targetId);
                if (target && areInSameScope(session, target)) {
                    send(target.ws, {
                        type: 'file-offer',
                        senderId: sessionId,
                        senderName: session.codename,
                        transferId: msg.transferId,
                        files: msg.files,    // [{name, size, type}]
                    });
                }
                break;
            }

            // -- File Transfer Response (accept / reject) --
            case 'file-response': {
                const target = sessions.get(msg.targetId);
                if (target) {
                    send(target.ws, {
                        type: 'file-response',
                        senderId: sessionId,
                        transferId: msg.transferId,
                        accepted: msg.accepted,
                    });
                }
                break;
            }

            // -- Text Message (fallback for when DC is unavailable) --
            case 'text-message': {
                const target = sessions.get(msg.targetId);
                if (target && areInSameScope(session, target)) {
                    send(target.ws, {
                        type: 'text-message',
                        senderId: sessionId,
                        senderName: session.codename,
                        text: msg.text,
                    });
                }
                break;
            }

            // -- Room Management --
            case 'join-room': {
                const code = (msg.roomCode || '').toLowerCase().trim();
                if (!code || code.length > 8) break;
                // Check room size
                let roomSize = 0;
                for (const [, s] of sessions) { if (s.roomCode === code) roomSize++; }
                if (roomSize >= CONFIG.MAX_ROOM_SIZE) {
                    send(ws, { type: 'error', message: 'Room is full.' });
                    break;
                }
                session.roomCode = code;
                send(ws, { type: 'room-joined', roomCode: code });
                broadcastDeviceLists();
                break;
            }

            case 'leave-room': {
                session.roomCode = null;
                send(ws, { type: 'room-left' });
                broadcastDeviceLists();
                break;
            }

            // -- Heartbeat --
            case 'ping': {
                send(ws, { type: 'pong' });
                break;
            }
        }
    });

    ws.on('close', () => {
        if (sessionId) removeSession(sessionId);
        else {
            const c = (ipConnectionCount.get(ip) || 1) - 1;
            if (c <= 0) ipConnectionCount.delete(ip);
            else ipConnectionCount.set(ip, c);
        }
    });

    ws.on('error', () => {
        if (sessionId) removeSession(sessionId);
    });
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  QuickDrop signaling server running!\n`);
    console.log(`  Local:   http://localhost:${PORT}`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`  Network: http://${net.address}:${PORT}`);
            }
        }
    }
    console.log('');
});
