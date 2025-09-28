// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

// Setup Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000", // local React dev
      "http://localhost", // raw localhost
      "https://john.pianogod.com", // ✅ your live frontend
      "https://josh-pianogod.onrender.com", // Render backend domain (for testing)
    ],
    methods: ["GET", "POST"],
  },
});

// Use CORS middleware globally
app.use(cors());

// Test route (optional)
app.get("/", (req, res) => {
  res.send("✅ Pianogod socket server is running!");
});

// Handle WebSocket connections
io.on("connection", (socket) => {
  console.log("🔌 A user connected:", socket.id);

  // By default, assign to a "lobby" room until they send joinRoom
  socket.join("lobby");

  // Handle joining a room
  socket.on("joinRoom", (room) => {
    // Leave lobby if they were in it
    socket.leave("lobby");

    // Join requested room
    socket.join(room);
    console.log(`👥 User ${socket.id} joined room: ${room}`);

    // Let others in the room know someone joined
    socket.to(room).emit("userJoined", { userId: socket.id, room });
  });

  // Handle data sync inside a room
  socket.on("syncData", (data) => {
    const { room, payload, senderId } = data;
    console.log(`📡 Broadcasting to room ${room}:`, payload);

    socket.to(room).emit("updateData", { payload, senderId });
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("❌ A user disconnected:", socket.id);
  });
});

// Use Render’s PORT or fallback to 3000 locally
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
