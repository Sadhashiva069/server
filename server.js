import express from 'express'; // Add Express import
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Chess } from 'chess.js';
import { fileURLToPath } from 'url'; // Add for file path handling
import { dirname, join } from 'path'; // Add for file path handling

// Get directory path for static file serving
const __filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

// Create Express app
const app = express();

// Create HTTP server with Express
const httpServer = createServer(app);

// Configure Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://recordings-polyphonic-purchasing-wildlife.trycloudflare.com",
      "https://incredible-pressed-reading-develop.trycloudflare.com",
      // Add your Render URL when you have it
      process.env.RENDER_EXTERNAL_URL || "https://threed-chess-6rhz.onrender.com"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true // Allow Engine.IO v3 client
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Serve static files from the dist directory (one level up from server folder)
app.use(express.static(join(__dirname, '..', 'dist')));

// Serve index.html for all routes for client-side routing
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

// Update your games object to include last activity time
const games = {};

io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);

  // Add a sync-game-state event for clients to request current state
  socket.on('sync-game-state', ({ gameId }) => {
    const game = games[gameId];
    if (game) {
      // Update last activity time
      game.lastActivity = Date.now();
      
      // Send the current state to the requesting client
      socket.emit('game-state-synced', { 
        fen: game.gameState.fen(),
        turn: game.turn,
        isCheck: game.gameState.isCheck(),
        isCheckmate: game.gameState.isCheckmate(),
        isDraw: game.gameState.isDraw()
      });
      // Line 69 (Corrected)
      console.log(`Synced state for game ${gameId} for user ${socket.id}`);
    } else {
      console.log(`Sync requested for non-existent game ${gameId} by user ${socket.id}`);
    }
  });

  socket.on('create-game', () => {
    const gameId = Math.random().toString(36).substring(2, 8);
    games[gameId] = {
      gameState: new Chess(),
      players: [socket.id],
      turn: 'w',
      lastActivity: Date.now(),
      playerInfo: {
        [socket.id]: {
          color: 'w',
          connected: true,
          lastSeen: Date.now()
        }
      }
    };
    socket.join(gameId);
    socket.emit('game-created', { gameId, color: 'w' });
    console.log(Game ${gameId} created by user ${socket.id});
  });

  socket.on('join-game', ({ gameId }) => {
    if (games[gameId] && games[gameId].players.length < 2) {
      games[gameId].players.push(socket.id);
      games[gameId].playerInfo[socket.id] = {
        color: 'b',
        connected: true,
        lastSeen: Date.now()
      };
      games[gameId].lastActivity = Date.now();
      
      socket.join(gameId);
      socket.emit('game-joined', { gameId, color: 'b' });
      io.to(gameId).emit('game-start', { 
        fen: games[gameId].gameState.fen(),
        turn: games[gameId].turn
      });
      console.log(User ${socket.id} joined game ${gameId});
    } else {
      socket.emit('error', { message: 'Game not found or full' });
      console.log(User ${socket.id} failed to join game ${gameId} (Not found or full));
    }
  });

  socket.on('make-move', ({ gameId, from, to }) => {
    try {
      const game = games[gameId];
      if (!game) {
        console.log(Move attempt on non-existent game ${gameId} by user ${socket.id});
        return;
      }

      const playerIndex = game.players.indexOf(socket.id);
      const playerColor = playerIndex === 0 ? 'w' : 'b';

      if (game.turn !== playerColor) {
        socket.emit('error', { message: 'Not your turn' });
        return;
      }

      const move = game.gameState.move({ from, to, promotion: 'q' });
      
      if (move) {
        game.turn = game.turn === 'w' ? 'b' : 'w';
        game.lastActivity = Date.now();
        
        io.to(gameId).emit('move-made', {
          from,
          to,
          fen: game.gameState.fen(),
          turn: game.turn,
          isCheck: game.gameState.isCheck(),
          isCheckmate: game.gameState.isCheckmate(),
          isDraw: game.gameState.isDraw(),
          move: move // Include the full move object
        });
        console.log(Move made in game ${gameId} by user ${socket.id});
        
        // Send explicit turn notification to prevent desynchronization
        const nextPlayerIndex = game.turn === 'w' ? 0 : 1;
        const nextPlayerId = game.players[nextPlayerIndex];
        
        // Only emit if the player is connected
        if (nextPlayerId && game.playerInfo[nextPlayerId]?.connected) {
          io.to(nextPlayerId).emit('your-turn');
        }
      }
    } catch (error) {
      console.error(Error processing move: ${error.message});
      socket.emit('error', { message: error.message });
    }
  });

  // Add heartbeat to keep connection alive
  socket.on('heartbeat', ({ gameId }) => {
    if (games[gameId] && games[gameId].playerInfo[socket.id]) {
      games[gameId].playerInfo[socket.id].lastSeen = Date.now();
      games[gameId].playerInfo[socket.id].connected = true;
    }
  });

  // Handle reconnection attempts
  socket.on('reconnect-to-game', ({ gameId, previousId }) => {
    const game = games[gameId];
    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }
    
    // Check if this is a known player trying to reconnect
    const playerIndex = game.players.indexOf(previousId);
    if (playerIndex !== -1) {
      // Replace the old socket id with the new one
      game.players[playerIndex] = socket.id;
      
      // Transfer player info
      game.playerInfo[socket.id] = game.playerInfo[previousId];
      game.playerInfo[socket.id].connected = true;
      game.playerInfo[socket.id].lastSeen = Date.now();
      delete game.playerInfo[previousId];
      
      // Rejoin the room
      socket.join(gameId);
      
      // Send the current game state
      const playerColor = playerIndex === 0 ? 'w' : 'b';
      socket.emit('reconnected-to-game', {
        gameId,
        color: playerColor,
        fen: game.gameState.fen(),
        turn: game.turn,
        isCheck: game.gameState.isCheck(),
        isCheckmate: game.gameState.isCheckmate(),
        isDraw: game.gameState.isDraw()
      });
      console.log(User ${socket.id} reconnected to game ${gameId} (was ${previousId}));
      
      // Notify opponent
      const opponentIndex = playerIndex === 0 ? 1 : 0;
      if (game.players.length > opponentIndex) {
        const opponentId = game.players[opponentIndex];
        io.to(opponentId).emit('opponent-reconnected');
      }
    } else {
      socket.emit('error', { message: 'You are not a player in this game' });
    }
  });

  socket.on('offer-draw', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    
    const playerIndex = game.players.indexOf(socket.id);
    const opponentIndex = playerIndex === 0 ? 1 : 0;
    
    if (game.players.length > opponentIndex) {
      game.lastActivity = Date.now();
      const opponentId = game.players[opponentIndex];
      io.to(opponentId).emit('draw-offered');
      console.log(Draw offered in game ${gameId} by user ${socket.id});
    }
  });

  socket.on('accept-draw', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    
    game.lastActivity = Date.now();
    io.to(gameId).emit('draw-accepted');
    console.log(Draw accepted in game ${gameId});
    
    // Mark the game as finished but keep it for a while
    game.finished = true;
    game.result = 'draw';
  });

  socket.on('resign-game', ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    
    const playerIndex = game.players.indexOf(socket.id);
    const playerColor = playerIndex === 0 ? 'w' : 'b';
    const winner = playerColor === 'w' ? 'b' : 'w';
    
    game.lastActivity = Date.now();
    io.to(gameId).emit('player-resigned', { winner });
    console.log(Player resigned in game ${gameId}. Winner: ${winner});
    
    // Mark the game as finished but keep it for a while
    game.finished = true;
    game.result = winner;
  });

  socket.on('disconnect', () => {
    console.log('user disconnected:', socket.id);
    
    // Handle player disconnection
    Object.keys(games).forEach(gameId => {
      const game = games[gameId];
      const playerIndex = game.players.indexOf(socket.id);
      
      if (playerIndex !== -1) {
        // Mark player as disconnected but don't remove them
        if (game.playerInfo[socket.id]) {
          game.playerInfo[socket.id].connected = false;
          game.playerInfo[socket.id].lastSeen = Date.now();
        }
        
        // Notify opponent of disconnection
        const opponentIndex = playerIndex === 0 ? 1 : 0;
        if (game.players.length > opponentIndex) {
          const opponentId = game.players[opponentIndex];
          io.to(opponentId).emit('opponent-disconnected');
        }
      }
    });
  });
});

// Add a cleanup interval for inactive games
setInterval(() => {
  const now = Date.now();
  Object.keys(games).forEach(gameId => {
    const game = games[gameId];
    // Remove games inactive for more than 24 hours
    if (now - game.lastActivity > 24 * 60 * 60 * 1000) {
      console.log(Removing inactive game: ${gameId});
      delete games[gameId];
    }
  });
}, 60 * 60 * 1000); // Check every hour

// Use environment variable for port (required for Render)
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(Server listening on port ${PORT});
});
