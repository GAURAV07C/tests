import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { registerSocketHandlers } from "./socket.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const publicDir = path.resolve(__dirname, "..", "public");
app.use(express.static(publicDir));
app.get("/healthz", (_request, response) => {
    response.status(200).json({ ok: true });
});
const server = http.createServer(app);
const io = new Server(server, {
    // More tolerant heartbeat for mobile background pauses.
    pingInterval: 25_000,
    pingTimeout: 120_000,
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});
registerSocketHandlers(io);
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
    console.log(`Remote support server listening on http://localhost:${port}`);
});
