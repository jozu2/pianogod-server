// filepath: server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins (or replace "*" with your frontend URL if you want stricter security)
    methods: ["GET", "POST"],
  },
});

// Use CORS middleware
app.use(cors());

// Basic test route
app.get("/", (req, res) => {
  res.send("Server is running ✅");
});

// Handle WebSocket connections
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Join a specific room
  socket.on("joinRoom", (room) => {
    socket.join(room);
    console.log(`User ${socket.id} joined room: ${room}`);
  });

  // Broadcast changes to other users in the room
  socket.on("syncData", (data) => {
    const { room, payload, senderId } = data;
    console.log(`Broadcasting data to room ${room}:`, payload);
    socket.to(room).emit("updateData", { payload, senderId });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("A user disconnected:", socket.id);
  });
});

// Start the server
const PORT = process.env.PORT || 3000; // ✅ Works on Render or locally
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
