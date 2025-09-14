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
        message: 'Rinascimento Oscuro Server Online v2.1',
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

    // Heartbeat per keep-alive
    socket.on('heartbeat', () => {
        socket.emit('heartbeat-ack');
    });

    // NUOVI HANDLER per eventi camelCase del client

    // Creazione sessione
    socket.on('createSession', (data) => {
        const sessionId = 'rinascimento-' + Math.random().toString(36).substring(2, 8);
        const session = {
            id: sessionId,
            masterId: null,
            players: new Map(),
            gameLog: [],
            gameState: {},
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        
        sessions.set(sessionId, session);
        
        socket.emit('sessionCreated', { 
            sessionId: sessionId,
            success: true 
        });
        
        console.log('Session created:', sessionId);
    });

    // Unirsi a sessione
    socket.on('joinSession', (data) => {
        const { sessionId } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            socket.emit('sessionError', { 
                message: 'Sessione non trovata',
                code: 'SESSION_NOT_FOUND'
            });
            return;
        }
        
        socket.join(sessionId);
        socket.sessionId = sessionId;
        session.lastActivity = Date.now();
        
        const players = Array.from(session.players.values());
        
        socket.emit('joinedSession', {
            sessionId: sessionId,
            players: players,
            gameLog: session.gameLog
        });
        
        console.log(`Client ${socket.id} joined session ${sessionId}`);
    });

    // Unirsi come Game Master
    socket.on('joinAsGameMaster', (data) => {
        const { sessionId, playerData } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            socket.emit('sessionError', { 
                message: 'Sessione non trovata' 
            });
            return;
        }

        // Verifica se c'è già un master
        if (session.masterId && session.players.get(session.masterId)?.online) {
            socket.emit('sessionError', { 
                message: 'C\'è già un Game Master in questa sessione' 
            });
            return;
        }
        
        const player = {
            id: socket.id,
            name: playerData.name,
            characterName: playerData.characterName || '',
            characterConcept: playerData.characterConcept || '',
            isMaster: true,
            online: true,
            joinedAt: Date.now()
        };
        
        session.players.set(socket.id, player);
        session.masterId = socket.id;
        session.lastActivity = Date.now();
        
        socket.playerId = socket.id;
        socket.isMaster = true;
        
        socket.emit('playerJoined', {
            playerId: socket.id,
            playerData: player,
            isMaster: true
        });
        
        // Notifica altri giocatori
        socket.to(sessionId).emit('playerUpdate', {
            player: player
        });
        
        console.log(`${player.name} joined as GM in session ${sessionId}`);
    });

    // Unirsi come giocatore
    socket.on('joinAsPlayer', (data) => {
        const { sessionId, playerData } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            socket.emit('sessionError', { 
                message: 'Sessione non trovata' 
            });
            return;
        }
        
        const player = {
            id: socket.id,
            name: playerData.name,
            characterName: playerData.characterName || '',
            characterConcept: playerData.characterConcept || '',
            isMaster: false,
            online: true,
            joinedAt: Date.now()
        };
        
        session.players.set(socket.id, player);
        session.lastActivity = Date.now();
        
        socket.playerId = socket.id;
        socket.isMaster = false;
        
        socket.emit('playerJoined', {
            playerId: socket.id,
            playerData: player,
            isMaster: false
        });
        
        // Notifica altri giocatori
        socket.to(sessionId).emit('playerUpdate', {
            player: player
        });
        
        console.log(`${player.name} joined as player in session ${sessionId}`);
    });

    // Riconnessione a sessione esistente
    socket.on('rejoinSession', (data) => {
        const { sessionId, playerId } = data;
        const session = sessions.get(sessionId);
        
        if (!session || !session.players.has(playerId)) {
            socket.emit('sessionError', { 
                message: 'Impossibile riconnettersi alla sessione' 
            });
            return;
        }
        
        socket.join(sessionId);
        socket.sessionId = sessionId;
        socket.playerId = playerId;
        
        const player = session.players.get(playerId);
        player.online = true;
        socket.isMaster = player.isMaster;
        session.lastActivity = Date.now();
        
        socket.emit('playerJoined', {
            playerId: playerId,
            playerData: player,
            isMaster: player.isMaster
        });
        
        // Notifica altri giocatori della riconnessione
        socket.to(sessionId).emit('playerUpdate', {
            player: player
        });
        
        console.log(`${player.name} rejoined session ${sessionId}`);
    });

    // Aggiornamento personaggio
    socket.on('characterUpdate', (data) => {
        if (!socket.sessionId || !socket.playerId) return;
        
        const session = sessions.get(socket.sessionId);
        if (!session || !session.players.has(socket.playerId)) return;
        
        const player = session.players.get(socket.playerId);
        
        // Aggiorna i dati del personaggio
        if (data.character) {
            player.character = { ...player.character, ...data.character };
        }
        
        session.lastActivity = Date.now();
        
        // Broadcast ai altri giocatori
        socket.to(socket.sessionId).emit('gameStateUpdate', {
            type: 'characterUpdate',
            playerId: socket.playerId,
            playerName: player.name,
            character: data.character
        });
    });

    // Aggiornamenti di stato di gioco
    socket.on('gameStateUpdate', (data) => {
        if (!socket.sessionId) return;
        
        const session = sessions.get(socket.sessionId);
        if (!session) return;
        
        session.lastActivity = Date.now();
        
        // Aggiungi al log se è un messaggio
        if (data.type === 'diceRoll' || data.type === 'gmNote') {
            session.gameLog.push({
                timestamp: Date.now(),
                type: data.type,
                author: data.playerName || 'Sistema',
                content: data.note || `Tiro dadi: ${data.roll?.total}`,
                data: data
            });
        }
        
        // Broadcast a tutti nella sessione (incluso il mittente per i dadi)
        io.to(socket.sessionId).emit('gameStateUpdate', data);
    });

    // Ottenere sessioni attive
    socket.on('getActiveSessions', () => {
        const activeSessions = [];
        
        for (const [sessionId, session] of sessions.entries()) {
            const onlinePlayers = Array.from(session.players.values())
                .filter(p => p.online);
            
            if (onlinePlayers.length > 0) {
                activeSessions.push({
                    sessionId: sessionId,
                    playerCount: onlinePlayers.length,
                    hasMaster: session.masterId && 
                              session.players.get(session.masterId)?.online,
                    createdAt: session.createdAt
                });
            }
        }
        
        // Ordina per data di creazione
        activeSessions.sort((a, b) => b.createdAt - a.createdAt);
        
        socket.emit('activeSessions', {
            sessions: activeSessions
        });
    });

    // Aggiornamento note GM
    socket.on('gmNotesUpdate', (data) => {
        if (!socket.sessionId || !socket.isMaster) return;
        
        const session = sessions.get(socket.sessionId);
        if (!session) return;
        
        session.gmNotes = data.notes;
        session.lastActivity = Date.now();
        
        // Conferma salvavaggio
        socket.emit('gmNotesSaved');
    });

    // Acknowledgment dei messaggi
    socket.on('messageAck', (data) => {
        if (data.messageId) {
            socket.emit('messageAck', { messageId: data.messageId });
        }
    });

    // Test di connessione
    socket.on('ping', () => {
        socket.emit('pong');
    });

    // MANTIENI I VECCHI HANDLER per retrocompatibilità

    socket.on('create_session', (data, callback) => {
        const sessionId = 'rinascimento-' + Math.random().toString(36).substring(2, 8);
        sessions.set(sessionId, {
            id: sessionId,
            masterId: null,
            players: new Map(),
            gameLog: [{ 
                author: 'Sistema', 
                text: 'Sessione creata.', 
                timestamp: Date.now() 
            }],
            createdAt: Date.now(),
            lastActivity: Date.now()
        });
        
        if (callback) callback({ success: true, sessionId });
        console.log('Session created (legacy):', sessionId);
    });

    socket.on('join_session', (data, callback) => {
        const { sessionId, playerData } = data;
        const session = sessions.get(sessionId);
        
        if (!session) {
            if (callback) callback({ success: false, error: 'Sessione non trovata' });
            return;
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
        
        if (callback) {
            callback({ 
                success: true, 
                session: {
                    id: sessionId,
                    players: Array.from(session.players.values()),
                    gameLog: session.gameLog,
                    masterId: session.masterId
                }
            });
        }
        
        socket.to(sessionId).emit('player_joined', { player });
        console.log(`Player ${player.name} joined session ${sessionId} (legacy)`);
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

    // Gestione disconnessione
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        if (socket.sessionId) {
            const session = sessions.get(socket.sessionId);
            if (session && session.players.has(socket.id)) {
                const player = session.players.get(socket.id);
                player.online = false;
                session.lastActivity = Date.now();
                
                // Notifica altri giocatori
                socket.to(socket.sessionId).emit('playerUpdate', {
                    player: player
                });
                
                // Legacy event
                socket.to(socket.sessionId).emit('player_disconnected', { 
                    playerId: socket.id, 
                    playerName: player.name 
                });
                
                console.log(`Player ${player.name} disconnected from ${socket.sessionId}`);
            }
        }
    });

    // Error handling
    socket.on('error', (error) => {
        console.error('Socket error:', error);
        socket.emit('error', { 
            message: 'Errore del server',
            code: 'SERVER_ERROR' 
        });
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        sessions: sessions.size,
        uptime: process.uptime(),
        version: '2.1.0'
    });
});

// Sessions endpoint per API REST
app.get('/sessions', (req, res) => {
    const activeSessions = [];
    
    for (const [sessionId, session] of sessions.entries()) {
        const onlinePlayers = Array.from(session.players.values()).filter(p => p.online);
        activeSessions.push({
            id: sessionId,
            playerCount: onlinePlayers.length,
            totalPlayers: session.players.size,
            createdAt: session.createdAt || Date.now(),
            hasMaster: session.masterId !== null &&
                      session.players.get(session.masterId)?.online,
            masterName: session.masterId ? 
                       session.players.get(session.masterId)?.name : null
        });
    }
    
    activeSessions.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ sessions: activeSessions });
});

server.listen(PORT, () => {
    console.log(`🎲 Rinascimento Oscuro server v2.1 running on port ${PORT}`);
});
