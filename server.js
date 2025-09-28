// server/realtime/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

// Use native fetch on Node 18+, else fall back to node-fetch
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import("node-fetch").then((m) => m.default(...args));
}

const SOCKET_SECRET = "f3c6b8a2d1e54c7890a4f9d7c23e1b6f"; // must match PHP Configure::read('Socket.secret')

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
  cors: {
    origin: (origin, cb) => {
      // Allow localhost and 127.0.0.1 (any port)
      if (!origin) return cb(null, true);
      const ok =
        /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
        /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin);
      cb(null, ok);
    },
    methods: ["GET", "POST"],
  },
});

// --- Simple rate limiter ---
const rateLimits = new Map();
function isRateLimited(socket, event, interval = 200) {
  const now = Date.now();
  const key = socket.id + "|" + event;
  const last = rateLimits.get(key) || 0;
  if (now - last < interval) return true;
  rateLimits.set(key, now);
  return false;
}

// --- Auth middleware (token = base64(json) + "." + hmac) ---
io.use((socket, next) => {
  const { token } = socket.handshake.auth || {};
  if (!token) return next(new Error("No token provided"));
  try {
    const parts = String(token).split(".");
    if (parts.length !== 2) return next(new Error("Malformed token"));
    const [b64, sig] = parts;
    const json = Buffer.from(b64, "base64").toString();
    const expected = crypto
      .createHmac("sha256", SOCKET_SECRET)
      .update(json)
      .digest("hex");
    if (sig !== expected) return next(new Error("Invalid signature"));

    const payload = JSON.parse(json); // { slug, user_id, display_name, exp }
    if (!payload || typeof payload !== "object")
      return next(new Error("Invalid payload"));
    if (!payload.slug || typeof payload.slug !== "string")
      return next(new Error("Missing slug"));
    if (payload.exp && payload.exp < Date.now() / 1000)
      return next(new Error("Token expired"));
    if (payload.user_id == null)
      return next(new Error("Authentication required"));

    socket.user = {
      user_id: payload.user_id,
      display_name: payload.display_name || String(payload.user_id),
    };
    socket.data = socket.data || {};
    socket.data.slugFromToken = payload.slug;
    next();
  } catch (err) {
    next(new Error("Token verification failed"));
  }
});

// --- Helpers: presence + delete endpoints in PHP ---
async function postPresence(slug, user, status) {
  try {
    await fetchFn(
      `http://localhost/collab/${encodeURIComponent(slug)}/presence`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user.user_id || null,
          display_name: user.display_name || null,
          status, // 'active' | 'inactive'
        }),
      }
    );
  } catch (e) {
    console.error("presence POST failed", e.message);
  }
}

async function postLeave(slug, socket) {
  try {
    const url = `http://localhost/collab/${encodeURIComponent(slug)}/leave`;
    await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: socket.user.user_id,
        display_name: socket.user.display_name,
      }),
    });
  } catch (e) {
    console.error("leave POST failed", e.message);
  }
}

// --- Main handlers ---
io.on("connection", (socket) => {
  console.log("User connected:", socket.id, socket.user);

  // Ensure we don't attach duplicate handlers if a client calls join twice
  let joined = false;

  socket.on("join", async (slug) => {
    if (joined) return;
    if (typeof slug !== "string" || !slug) return;

    // Optional safety: enforce slug must match the one in the token if you include it there
    if (socket.data.slugFromToken && socket.data.slugFromToken !== slug) {
      return socket.emit("error", { message: "Slug mismatch" });
    }

    joined = true;
    socket.data.slug = slug;

    // Stable participant key: prefer user_id
    const key = `u:${socket.user.user_id}`;
    socket.data.participantKey = key;

    socket.join(slug);

    // Broadcast join + mark ACTIVE in DB
    io.to(slug).emit("user:join", {
      id: socket.id,
      user: socket.user, // { user_id, display_name }
      key, // u:{user_id}
    });

    await postPresence(slug, socket.user, "active");

    // Heartbeat: client should emit 'presence:ping' every ~10s
    socket.on("presence:ping", async () => {
      if (!socket.data.slug) return;
      if (isRateLimited(socket, "presence:ping", 5000)) return;
      await postPresence(socket.data.slug, socket.user, "active");
      io.to(socket.data.slug).emit("user:presence", {
        key: socket.data.participantKey,
        status: "active",
        last_seen: Date.now(),
      });
    });
  });

  socket.on("state:update", (data) => {
    if (isRateLimited(socket, "state:update")) return;
    if (
      !data ||
      typeof data.slug !== "string" ||
      typeof data.diff !== "object"
    ) {
      return socket.emit("error", { message: "Invalid state:update payload" });
    }
    io.to(data.slug).emit("state:update", {
      diff: data.diff,
      user: socket.user,
    });
  });

  socket.on("session:end", (data) => {
    if (!data || typeof data.slug !== "string") return;
    io.to(data.slug).emit("session:ended", { endedBy: socket.user });
  });

  // Before rooms are cleared: broadcast LEAVE + mark INACTIVE + delete from DB
  socket.on("disconnecting", async () => {
    const slug = socket.data.slug;
    if (!slug) return;

    io.to(slug).emit("user:leave", {
      id: socket.id,
      user: socket.user,
    });

    await postPresence(slug, socket.user, "inactive");
    await postLeave(slug, socket);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

server.listen(3001, () => {
  console.log("Socket.IO running at http://localhost:3001");
});
