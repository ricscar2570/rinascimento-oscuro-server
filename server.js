const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"],
        allowedHeaders: ["*"],
        credentials: true
    }
});

const sessions = new Map();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Health check per Render
app.get('/', (req, res) => {
    res.json({ 
        message: 'Ucronie e Tesori Server Online',
        status: 'ok',
        sessions: sessions.size,
        timestamp: new Date().toISOString()
    });
});

// Cleanup sessioni inattive ogni ora
setInterval(() => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    for (const [sessionId, session] of sessions.entries()) {
        const allPlayersOffline = Array.from(session.players.values())
            .every(player => !player.online);
        
        if (allPlayersOffline && (now - session.lastActivity) > oneHour) {
            sessions.delete(sessionId);
            console.log(`Cleaned up inactive session: ${sessionId}`);
        }
    }
}, 3600000);

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('create_session', (data, callback) => {
        const sessionId = 'ucronie-' + Math.random().toString(36).substring(2, 8);
        sessions.set(sessionId, {
            id: sessionId,
            masterId: null,
            players: new Map(),
            gameLog: [{ 
                author: 'Sistema', 
                text: 'Missione creata.', 
                timestamp: Date.now() 
            }],
            lastActivity: Date.now()
        });
        callback({ success: true, sessionId });
        console.log('Session created:', sessionId);
    });

    socket.on('join_session', (data, callback) => {
        const { sessionId, playerData } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            return callback({ success: false, error: 'Sessione non trovata' });
        }
        
        socket.join(sessionId);
        socket.sessionId = sessionId;
        session.lastActivity = Date.now();
        
        const player = { ...playerData, id: socket.id, online: true };
        session.players.set(socket.id, player);
        
        if (!session.masterId && playerData.wantsToBeMaster) {
            session.masterId = socket.id;
            player.isMaster = true;
        }
        
        callback({ 
            success: true, 
            session: {
                id: sessionId,
                players: Array.from(session.players.values()),
                gameLog: session.gameLog,
                masterId: session.masterId
            }
        });
        
        socket.to(sessionId).emit('player_joined', { player });
        console.log(`Player ${player.name} joined session ${sessionId}`);
    });

    socket.on('game_message', (data) => {
        if (!socket.sessionId) return;
        const session = sessions.get(socket.sessionId);
        if (session) {
            const message = { ...data, timestamp: Date.now() };
            session.gameLog.push(message);
            session.lastActivity = Date.now();
            io.to(socket.sessionId).emit('game_message', message);
        }
    });

    socket.on('update_player', (data) => {
        if (!socket.sessionId) return;
        const session = sessions.get(socket.sessionId);
        if (session && session.players.has(socket.id)) {
            Object.assign(session.players.get(socket.id), data);
            session.lastActivity = Date.now();
            socket.to(socket.sessionId).emit('player_updated', { 
                playerId: socket.id, 
                playerData: session.players.get(socket.id) 
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.sessionId) {
            const session = sessions.get(socket.sessionId);
            if (session && session.players.has(socket.id)) {
                const player = session.players.get(socket.id);
                player.online = false;
                session.lastActivity = Date.now();
                socket.to(socket.sessionId).emit('player_disconnected', { 
                    playerId: socket.id, 
                    playerName: player.name 
                });
                console.log(`Player ${player.name} disconnected from ${socket.sessionId}`);
            }
        }
    });

    socket.on('ping', (callback) => {
        if (callback) callback('pong');
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        sessions: sessions.size,
        uptime: process.uptime()
    });
});

// Sessions endpoint for active sessions browser
app.get('/sessions', (req, res) => {
    const activeSessions = [];
    
    for (const [sessionId, session] of sessions.entries()) {
        const onlinePlayers = Array.from(session.players.values()).filter(p => p.online);
        activeSessions.push({
            id: sessionId,
            playerCount: onlinePlayers.length,
            totalPlayers: session.players.size,
            createdAt: session.createdAt || Date.now(),
            hasMaster: session.masterId !== null,
            masterName: session.masterId ? session.players.get(session.masterId)?.name : null
        });
    }
    
    // Sort by creation time (newest first)
    activeSessions.sort((a, b) => b.createdAt - a.createdAt);
    
    res.json({ sessions: activeSessions });
});

server.listen(PORT, () => {
    console.log(`🎲 Ucronie e Tesori server running on port ${PORT}`);
});
