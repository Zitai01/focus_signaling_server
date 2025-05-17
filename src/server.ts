// backend-server/src/server.ts
import http from 'http';
import express, { Express } from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config(); // For loading environment variables from .env file

const app: Express = express();
const httpServer = http.createServer(app);
app.use(cors());
const PORT = process.env.PORT || 3001; // Backend server port

// Configure CORS
// Adjust the origin to match your frontend's URL in production
const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:3000'];

const corsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST'],
    credentials: true,
};

//app.use(cors(corsOptions));
//app.options('/api/', cors(corsOptions)); // Enable pre-flight requests

const io = new SocketIOServer(httpServer, {
    cors: corsOptions,
    // path: "/my-custom-path/socket.io" // Optional: if you need a custom path
});

// In-memory store for rooms and user-socket mapping
// rooms: Map<roomId, Set<userId>>
const rooms = new Map<string, Set<string>>();
// userIdToSocketIdMap: Map<userId, socketId>
const userIdToSocketIdMap = new Map<string, string>();
// socketIdToUserIdMap: Map<socketId, userId> (for easier cleanup on disconnect)
const socketIdToUserIdMap = new Map<string, string>();


io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('join-room', (roomId: string, userId: string) => {
        console.log(`User ${userId} (socket ${socket.id}) attempting to join room ${roomId}`);

        socket.join(roomId);
        userIdToSocketIdMap.set(userId, socket.id);
        socketIdToUserIdMap.set(socket.id, userId);

        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set<string>());
        }
        const roomUsersSet = rooms.get(roomId)!;
        roomUsersSet.add(userId);

        const usersInThisRoom = Array.from(roomUsersSet);
        console.log(`Users in room ${roomId}:`, usersInThisRoom);

        // Send list of existing users (their userIds) to the new joiner (excluding self)
        const otherUserIdsInRoom = usersInThisRoom.filter(id => id !== userId);
        socket.emit('existing-users', { users: otherUserIdsInRoom });

        // Notify other users in the room that a new user has joined
        socket.to(roomId).emit('user-joined', { userId });
    });

    socket.on('signal', (payload: {
        type: 'offer' | 'answer' | 'candidate';
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit | null;
        senderUserId: string;
        targetUserId: string;
        roomId: string;
    }) => {
        const { targetUserId, senderUserId } = payload;
        console.log(`Relaying signal: ${payload.type} from ${senderUserId} to ${targetUserId} in room ${payload.roomId}`);

        const targetSocketId = userIdToSocketIdMap.get(targetUserId);
        if (targetSocketId) {
            // Send the signal directly to the target user's socket
            io.to(targetSocketId).emit('signal', payload);
        } else {
            console.warn(`Target user ${targetUserId} not found or socket not mapped for signal relay.`);
            // Optionally, notify sender that target is not available
            // socket.emit('signal-error', { targetUserId, message: 'Target user not connected' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        const disconnectedUserId = socketIdToUserIdMap.get(socket.id);

        if (disconnectedUserId) {
            // Clean up mappings
            userIdToSocketIdMap.delete(disconnectedUserId);
            socketIdToUserIdMap.delete(socket.id);

            // Remove user from all rooms they might have been in
            rooms.forEach((usersSet, roomId) => {
                if (usersSet.has(disconnectedUserId)) {
                    usersSet.delete(disconnectedUserId);
                    console.log(`User ${disconnectedUserId} left room ${roomId}.`);
                    // Notify other users in that room
                    socket.to(roomId).emit('user-left', { userId: disconnectedUserId });

                    if (usersSet.size === 0) {
                        rooms.delete(roomId);
                        console.log(`Room ${roomId} is now empty and removed.`);
                    } else {
                        console.log(`Users remaining in room ${roomId}:`, Array.from(usersSet));
                    }
                }
            });
        } else {
            console.log(`No userId found for disconnected socket ${socket.id}`);
        }
    });
});

// Basic route for health check or info
app.get('/', (req, res) => {
    res.send('Signaling Server is running.');
});

httpServer.listen(PORT, () => {
    console.log(`Signaling server is running on http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    io.close(() => {
        console.log('Socket.IO server closed.');
        httpServer.close(() => {
            console.log('HTTP server closed.');
            process.exit(0);
        });
    });
});