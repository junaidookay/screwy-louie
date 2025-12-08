import http from "http";
import path from "path";
import fs from "fs";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { Card, createDoubleDeck } from "../engine/card";
import { Deck } from "../engine/deck";
import { getDealCountForHand, getPhaseRequirementsForHand } from "../engine/game";
import { isValidGroup, isValidRun } from "../engine/rules";
import { scoreHand } from "../engine/scoring";

type PlayerSeat = {
  id: string;
  name: string;
  hand: Card[];
  hasDrawn: boolean;
  didDiscard: boolean;
  laidGroups: Card[][];
  laidRuns: Card[][];
  laidComplete: boolean;
  totalScore: number;
  ready: boolean;
};

type RoomState = {
  id: string;
  handNumber: number;
  players: PlayerSeat[];
  currentIndex: number;
  drawPile: Card[];
  discardPile: Card[];
  started: boolean;
  handComplete: boolean;
  lastScores: { playerId: string; name: string; hand: number; total: number }[];
  turnDeadline: number | null;
  turnMs: number;
  spectators: { id: string; name: string }[];
  lobbyDeadline: number | null;
  matchDeadline: number | null;
  matchLimitMs: number;
};

const rooms = new Map<string, RoomState>();
const turnTimers = new Map<string, NodeJS.Timeout>();
const lobbyTimers = new Map<string, NodeJS.Timeout>();
const matchTimers = new Map<string, NodeJS.Timeout>();
const disconnectTimers = new Map<string, NodeJS.Timeout>();
const TURN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MATCH_TIMEOUT_MS = 30 * 60 * 1000;
const recentMatches: { id: string; ended: number; reason: string; players: { name: string; totalScore: number }[] }[] = [];
const spectatorBySocket = new Map<string, { roomId: string; id: string }>();
const playerBySocket = new Map<string, { roomId: string; id: string }>();

function createRoom(): RoomState {
  const id = uuidv4().slice(0, 8);
  const room: RoomState = {
    id,
    handNumber: 1,
    players: [],
    currentIndex: 0,
    drawPile: [],
    discardPile: [],
    started: false,
    handComplete: false,
    lastScores: [],
    turnDeadline: null,
    turnMs: TURN_TIMEOUT_MS,
    spectators: [],
    lobbyDeadline: null,
    matchDeadline: null,
    matchLimitMs: MATCH_TIMEOUT_MS,
  };
  rooms.set(id, room);
  scheduleLobbyTimeout(room);
  return room;
}

function deal(room: RoomState): void {
  const deck = new Deck(createDoubleDeck(true));
  deck.shuffle();
  room.drawPile = deck.toArray();
  room.discardPile = [];
  room.handComplete = false;
  room.lastScores = [];
  const dealCount = getDealCountForHand(room.handNumber);
  for (const p of room.players) {
    p.hand = [];
    p.hasDrawn = false;
    p.didDiscard = false;
    p.laidGroups = [];
    p.laidRuns = [];
    p.laidComplete = false;
    for (let j = 0; j < dealCount; j++) {
      const c = room.drawPile.pop();
      if (!c) break;
      p.hand.push(c);
    }
  }
  const first = room.drawPile.pop();
  if (first) room.discardPile.push(first);
  room.currentIndex = 0;
  scheduleTurnTimeout(room);
  emitEvent(io, room, `Dealt hand ${room.handNumber}`);
}

function endHand(room: RoomState): void {
  room.handComplete = true;
  room.lastScores = [];
  room.turnDeadline = null;
  const t = turnTimers.get(room.id);
  if (t) { clearTimeout(t); turnTimers.delete(room.id); }
  for (const p of room.players) {
    const handScore = scoreHand(p.hand);
    p.totalScore += handScore;
    room.lastScores.push({ playerId: p.id, name: p.name, hand: handScore, total: p.totalScore });
  }
}

function scheduleTurnTimeout(room: RoomState): void {
  const existing = turnTimers.get(room.id);
  if (existing) clearTimeout(existing);
  room.turnDeadline = Date.now() + room.turnMs;
  const t = setTimeout(() => onTurnTimeout(room.id), room.turnMs);
  turnTimers.set(room.id, t);
}

function scheduleLobbyTimeout(room: RoomState): void {
  const t = lobbyTimers.get(room.id);
  if (t) clearTimeout(t);
  room.lobbyDeadline = Date.now() + 120000;
  const nt = setTimeout(() => onLobbyTimeout(room.id), 120000);
  lobbyTimers.set(room.id, nt);
}

function extendLobbyTimeout(room: RoomState, addMs: number): void {
  const t = lobbyTimers.get(room.id);
  if (t) clearTimeout(t);
  const now = Date.now();
  const base = room.lobbyDeadline && room.lobbyDeadline > now ? room.lobbyDeadline : now;
  room.lobbyDeadline = base + addMs;
  const remain = Math.max(0, room.lobbyDeadline - now);
  const nt = setTimeout(() => onLobbyTimeout(room.id), remain);
  lobbyTimers.set(room.id, nt);
}

function scheduleMatchTimeout(room: RoomState): void {
  const t = matchTimers.get(room.id);
  if (t) clearTimeout(t);
  const now = Date.now();
  const dur = Math.max(10 * 60 * 1000, Math.min(120 * 60 * 1000, room.matchLimitMs || MATCH_TIMEOUT_MS));
  room.matchDeadline = now + dur;
  const nt = setTimeout(() => onMatchTimeout(room.id), dur);
  matchTimers.set(room.id, nt);
}

function closeRoomInternal(io: Server, room: RoomState, reason: string): void {
  const lt = lobbyTimers.get(room.id);
  if (lt) { clearTimeout(lt); lobbyTimers.delete(room.id); }
  const tt = turnTimers.get(room.id);
  if (tt) { clearTimeout(tt); turnTimers.delete(room.id); }
  const mt = matchTimers.get(room.id);
  if (mt) { clearTimeout(mt); matchTimers.delete(room.id); }
  room.lobbyDeadline = null;
  room.matchDeadline = null;
  io.to(room.id).emit("room_closed", { ts: Date.now(), reason });
  emitEvent(io, room, "Room closed");
  try {
    recentMatches.push({ id: room.id, ended: Date.now(), reason, players: room.players.map(p => ({ name: p.name, totalScore: p.totalScore })) });
    if (recentMatches.length > 20) recentMatches.splice(0, recentMatches.length - 20);
  } catch {}
  rooms.delete(room.id);
}

function onMatchTimeout(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.started) return;
  matchTimers.delete(room.id);
  if (!room.handComplete) {
    endHand(room);
  }
  emitEvent(io, room, "Match time limit reached");
  broadcast(io, room);
  setTimeout(() => closeRoomInternal(io, room, "timeout"), 15000);
}

function onLobbyTimeout(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.started) return;
  if (room.players.length === 0) {
    io.to(room.id).emit("lobby_timeout", { ts: Date.now() });
    emitEvent(io, room, "Lobby expired");
    const tt = turnTimers.get(room.id);
    if (tt) { clearTimeout(tt); turnTimers.delete(room.id); }
    const lt = lobbyTimers.get(room.id);
    if (lt) { clearTimeout(lt); lobbyTimers.delete(room.id); }
    room.lobbyDeadline = null;
    rooms.delete(room.id);
  } else {
    emitEvent(io, room, "Lobby extended automatically while players present");
    extendLobbyTimeout(room, 120000);
    broadcast(io, room);
  }
}

function onTurnTimeout(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.handComplete) return;
  const cur = room.players[room.currentIndex];
  if (!cur.hasDrawn) {
    reshuffle(room);
    const c = room.drawPile.pop();
    if (c) { cur.hand.push(c); cur.hasDrawn = true; }
  }
  if (cur.hand.length > 0) {
    const card = cur.hand.pop() as Card;
    room.discardPile.push(card);
    cur.didDiscard = true;
    emitEvent(io, room, `${cur.name} timed out`);
  }
  room.currentIndex = (room.currentIndex + 1) % room.players.length;
  const next = room.players[room.currentIndex];
  next.hasDrawn = false;
  next.didDiscard = false;
  scheduleTurnTimeout(room);
  broadcast(io, room);
}

function reshuffle(room: RoomState): void {
  if (room.drawPile.length === 0 && room.discardPile.length > 1) {
    const top = room.discardPile.pop() as Card;
    const deck = new Deck(room.discardPile);
    deck.shuffle();
    room.drawPile = deck.toArray();
    room.discardPile = [top];
  }
}

function broadcast(io: Server, room: RoomState): void {
  io.to(room.id).emit("state", room);
}

function formatCardText(c: Card): string {
  if (c.rank === "Joker") return "Joker";
  if (!c.suit) return String(c.rank);
  return `${c.rank} ${c.suit}`;
}

function emitEvent(io: Server, room: RoomState, text: string): void {
  io.to(room.id).emit("event", { text, ts: Date.now() });
}

function roomSummary(room: RoomState): any {
  return {
    id: room.id,
    handNumber: room.handNumber,
    started: room.started,
    handComplete: room.handComplete,
    players: room.players.map(p => ({ name: p.name, totalScore: p.totalScore })),
    spectators: room.spectators.length,
  };
}

const baseDir = process.cwd();
const indexFile = path.join(baseDir, "dist", "index.html");
const staticRoots = [
  path.join(baseDir, "dist"),
  path.join(baseDir, "Card Game Assets"),
];
const server = http.createServer((req, res) => {
  const raw = String((req.url || "/").split("?")[0]);
  const p = decodeURIComponent(raw);
  const setType = (file: string) => {
    const ext = path.extname(file).toLowerCase();
    const map: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".ico": "image/x-icon",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    const ct = map[ext] || "application/octet-stream";
    try { res.setHeader("Content-Type", ct); } catch {}
  };

  if (p === "/favicon.ico") {
    res.statusCode = 204;
    res.setHeader("Content-Type", "image/x-icon");
    return res.end();
  }
  if (p === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end("{\"status\":\"ok\"}");
  }
  if (p === "/" || p === "/index.html") {
    try { setType(indexFile); fs.createReadStream(indexFile).pipe(res); } catch { res.statusCode = 500; res.end("error"); }
    return;
  }
  for (const root of staticRoots) {
    const rel = p.replace(/^\//, "");
    let sub = rel;
    const baseName = path.basename(root).toLowerCase();
    if (baseName === "card game assets" && sub.toLowerCase().startsWith("card game assets/")) {
      sub = sub.slice("Card Game Assets/".length);
    } else if (baseName === "dist" && sub.toLowerCase().startsWith("dist/")) {
      sub = sub.slice("dist/".length);
    }
    const file = path.join(root, sub);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      try { setType(file); fs.createReadStream(file).pipe(res); } catch { res.statusCode = 500; res.end("error"); }
      return;
    }
  }
  res.statusCode = 404;
  res.end("not found");
});
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, matchLimitMinutes }, cb) => {
    const room = createRoom();
    const player: PlayerSeat = { id: uuidv4(), name: name || "Player", hand: [], hasDrawn: false, didDiscard: false, laidGroups: [], laidRuns: [], laidComplete: false, totalScore: 0, ready: false };
    room.players.push(player);
    if (typeof matchLimitMinutes === "number" && Number.isFinite(matchLimitMinutes)) {
      const m = Math.floor(matchLimitMinutes);
      const clamped = Math.max(10, Math.min(120, m));
      room.matchLimitMs = clamped * 60 * 1000;
    }
    socket.join(room.id);
    playerBySocket.set(socket.id, { roomId: room.id, id: player.id });
    cb({ roomId: room.id, playerId: player.id });
    broadcast(io, room);
  });

  socket.on("joinRoom", ({ roomId, name }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    if (room.started && !room.handComplete) return cb({ error: "in_progress" });
    if (!room.started && room.players.length >= 4) return cb({ error: "full" });
    const player: PlayerSeat = { id: uuidv4(), name: name || "Player", hand: [], hasDrawn: false, didDiscard: false, laidGroups: [], laidRuns: [], laidComplete: false, totalScore: 0, ready: false };
    room.players.push(player);
    socket.join(room.id);
    playerBySocket.set(socket.id, { roomId: room.id, id: player.id });
    cb({ ok: true, playerId: player.id });
    broadcast(io, room);
    scheduleLobbyTimeout(room);
  });

  socket.on("spectateRoom", ({ roomId, name }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    socket.join(room.id);
    const sid = uuidv4();
    room.spectators.push({ id: sid, name: name || "Spectator" });
    spectatorBySocket.set(socket.id, { roomId: room.id, id: sid });
    cb({ ok: true });
    broadcast(io, room);
    io.to(room.id).emit("spectator_joined", { name: name || "Spectator" });
    scheduleLobbyTimeout(room);
  });

  socket.on("switchSeat", ({ roomId, playerId, toIndex }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    if (room.started && !room.handComplete) return cb({ error: "in_progress" });
    const from = room.players.findIndex(p => p.id === playerId);
    if (from < 0) return cb({ error: "player" });
    const maxIndex = room.players.length - 1;
    const dest = Math.max(0, Math.min(maxIndex, Number(toIndex) || 0));
    const currentId = room.players[room.currentIndex]?.id;
    const [p] = room.players.splice(from, 1);
    room.players.splice(dest, 0, p);
    room.currentIndex = room.players.findIndex(x => x.id === currentId);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("listRooms", (cb) => {
    const items: any[] = [];
    for (const r of rooms.values()) items.push(roomSummary(r));
    cb({ rooms: items });
  });

  socket.on("takeSeat", ({ roomId, name }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    if (!room.started && room.players.length >= 4) return cb({ error: "full" });
    const sidInfo = spectatorBySocket.get(socket.id);
    const player: PlayerSeat = { id: uuidv4(), name: name || "Player", hand: [], hasDrawn: false, didDiscard: false, laidGroups: [], laidRuns: [], laidComplete: false, totalScore: 0, ready: false };
    room.players.push(player);
    if (sidInfo) {
      const i = room.spectators.findIndex(s => s.id === sidInfo.id);
      if (i >= 0) room.spectators.splice(i, 1);
      spectatorBySocket.delete(socket.id);
    }
    socket.join(room.id);
    playerBySocket.set(socket.id, { roomId: room.id, id: player.id });
    cb({ ok: true, playerId: player.id });
    broadcast(io, room);
    scheduleLobbyTimeout(room);
  });

  socket.on("takeSeatAt", ({ roomId, name, toIndex }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    if (!room.started && room.players.length >= 4) return cb({ error: "full" });
    const player: PlayerSeat = { id: uuidv4(), name: name || "Player", hand: [], hasDrawn: false, didDiscard: false, laidGroups: [], laidRuns: [], laidComplete: false, totalScore: 0, ready: false };
    const dest = Math.max(0, Math.min(3, Number(toIndex) || 0));
    room.players.splice(dest, 0, player);
    const sidInfo = spectatorBySocket.get(socket.id);
    if (sidInfo) {
      const i = room.spectators.findIndex(s => s.id === sidInfo.id);
      if (i >= 0) room.spectators.splice(i, 1);
      spectatorBySocket.delete(socket.id);
    }
    socket.join(room.id);
    playerBySocket.set(socket.id, { roomId: room.id, id: player.id });
    cb({ ok: true, playerId: player.id });
    broadcast(io, room);
    scheduleLobbyTimeout(room);
  });

  socket.on("resume", ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const player = room.players.find(p => p.id === playerId);
    if (!player) return cb({ error: "player" });
    socket.join(room.id);
    playerBySocket.set(socket.id, { roomId: room.id, id: player.id });
    const pending = disconnectTimers.get(player.id);
    if (pending) { clearTimeout(pending); disconnectTimers.delete(player.id); emitEvent(io, room, `${player.name} reconnected`); }
    cb({ ok: true });
    broadcast(io, room);
  });

  socket.on("leaveSeat", ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx < 0) return cb({ error: "player" });
    const wasCur = room.players[room.currentIndex]?.id === playerId;
    const [p] = room.players.splice(idx, 1);
    p.ready = false;
    playerBySocket.delete(socket.id);
    const sid = uuidv4();
    room.spectators.push({ id: sid, name: p.name });
    spectatorBySocket.set(socket.id, { roomId: room.id, id: sid });

    // If match is ongoing, declare forfeit win to the remaining player
    if (room.started && !room.handComplete) {
      const winner = room.players[0] || null;
      const tt = turnTimers.get(room.id);
      if (tt) { clearTimeout(tt); turnTimers.delete(room.id); }
      room.turnDeadline = null;
      room.handComplete = true;
      room.lastScores = [];
      if (winner) {
        emitEvent(io, room, `${p.name} left. ${winner.name} wins by forfeit`);
        room.lastScores.push({ playerId: winner.id, name: winner.name, hand: 0, total: winner.totalScore });
      } else {
        emitEvent(io, room, `${p.name} left. Match ended`);
      }
      broadcast(io, room);
      setTimeout(() => closeRoomInternal(io, room, "forfeit"), 15000);
      return cb({ ok: true });
    }

    if (room.players.length === 0) {
      room.currentIndex = 0;
    } else if (wasCur) {
      room.currentIndex = room.currentIndex % room.players.length;
    } else {
      const currentId = room.players[room.currentIndex]?.id || null;
      room.currentIndex = currentId ? room.players.findIndex(x => x.id === currentId) : 0;
    }
    emitEvent(io, room, `${p.name} left seat`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("startMatch", ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const info = playerBySocket.get(socket.id);
    if (!info || info.roomId !== room.id) return cb({ error: "not_player" });
    if (room.players.length < 2) return cb({ error: "need_players" });
    room.started = true;
    deal(room);
    broadcast(io, room);
    emitEvent(io, room, `Match started`);
    cb({ ok: true });
    const lt = lobbyTimers.get(room.id);
    if (lt) { clearTimeout(lt); lobbyTimers.delete(room.id); }
    room.lobbyDeadline = null;
    scheduleMatchTimeout(room);
  });

  socket.on("extendLobby", ({ roomId, addMs }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: "not_found" });
    if (room.started) return cb && cb({ error: "started" });
    const info = playerBySocket.get(socket.id);
    if (!info || info.roomId !== room.id) return cb && cb({ error: "not_player" });
    const ms = Math.max(1000, Number(addMs) || 30000);
    extendLobbyTimeout(room, ms);
    broadcast(io, room);
    emitEvent(io, room, `Lobby extended ${(ms/1000)|0}s`);
    cb && cb({ ok: true, lobbyDeadline: room.lobbyDeadline });
  });

  socket.on("setReady", ({ roomId, playerId, ready }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: "not_found" });
    let pid = playerId as string | undefined;
    const info = playerBySocket.get(socket.id);
    if ((!pid || !room.players.some(x => x.id === pid)) && info && info.roomId === room.id) pid = info.id;
    const p = pid ? room.players.find(x => x.id === pid) : undefined;
    if (!p) return cb && cb({ error: "player" });
    p.ready = !!ready;
    broadcast(io, room);
    emitEvent(io, room, `${p.name} is ${p.ready ? "ready" : "not ready"}`);
    cb && cb({ ok: true });
    scheduleLobbyTimeout(room);
  });

  socket.on("setSeatReady", ({ roomId, seatIndex, ready }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: "not_found" });
    const idx = Math.max(0, Math.min(3, Number(seatIndex) || 0));
    const occupant = room.players[idx];
    if (!occupant) return cb && cb({ error: "empty" });
    const info = playerBySocket.get(socket.id);
    if (!info || info.roomId !== room.id || info.id !== occupant.id) return cb && cb({ error: "not_owner" });
    occupant.ready = !!ready;
    broadcast(io, room);
    emitEvent(io, room, `${occupant.name} is ${occupant.ready ? "ready" : "not ready"}`);
    cb && cb({ ok: true });
    scheduleLobbyTimeout(room);
  });

  socket.on("chat", ({ roomId, playerId, name, message }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: "not_found" });
    let nm = "Player";
    const playerInfo = playerBySocket.get(socket.id);
    if (playerInfo && playerInfo.roomId === room.id) {
      const p = room.players.find(x => x.id === playerInfo.id);
      if (p) nm = p.name;
    } else if (playerId) {
      const p = room.players.find(x => x.id === playerId);
      if (p) nm = p.name;
    } else {
      const sidInfo = spectatorBySocket.get(socket.id);
      if (sidInfo && sidInfo.roomId === room.id) {
        const spec = room.spectators.find(s => s.id === sidInfo.id);
        if (spec) nm = spec.name; else nm = "Spectator";
      } else if (typeof name === "string" && name.length) {
        nm = String(name);
      }
    }
    const msg = String(message || "").slice(0, 300);
    io.to(room.id).emit("chat", { name: nm, message: msg, ts: Date.now() });
    cb && cb({ ok: true });
  });

  socket.on("draw", ({ roomId, playerId, from }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (cur.hasDrawn) return cb({ error: "already_drawn" });
    if (from === "pile") {
      reshuffle(room);
      const c = room.drawPile.pop();
      if (!c) return cb({ error: "empty" });
      cur.hand.push(c);
      cur.hasDrawn = true;
      emitEvent(io, room, `${cur.name} drew from pile`);
    } else if (from === "discard") {
      const c = room.discardPile.pop();
      if (!c) return cb({ error: "empty" });
      cur.hand.push(c);
      cur.hasDrawn = true;
      emitEvent(io, room, `${cur.name} drew from discard`);
    }
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("discard", ({ roomId, playerId, index }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (!cur.hasDrawn) return cb({ error: "need_draw" });
    const card = cur.hand.splice(index, 1)[0];
    if (!card) return cb({ error: "index" });
    room.discardPile.push(card);
    cur.didDiscard = true;
    emitEvent(io, room, `${cur.name} discarded ${formatCardText(card)}`);
    if (cur.hand.length === 0) {
      endHand(room);
      emitEvent(io, room, `Hand complete`);
    }
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("endTurn", ({ roomId, playerId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (!cur.didDiscard) return cb({ error: "need_discard" });
    if (room.handComplete) return cb({ error: "hand_complete" });
    room.currentIndex = (room.currentIndex + 1) % room.players.length;
    const next = room.players[room.currentIndex];
    next.hasDrawn = false;
    next.didDiscard = false;
    scheduleTurnTimeout(room);
    emitEvent(io, room, `${cur.name} ended turn`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("giveDiscardTo", ({ roomId, playerId, targetId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (room.handComplete) return cb({ error: "hand_complete" });
    const target = room.players.find(p => p.id === targetId);
    if (!target || target.id === cur.id) return cb({ error: "target" });
    const top = room.discardPile.pop();
    if (!top) return cb({ error: "empty" });
    target.hand.push(top);
    reshuffle(room);
    const bonus = room.drawPile.pop();
    if (bonus) target.hand.push(bonus);
    reshuffle(room);
    const startCard = room.drawPile.pop();
    if (startCard) cur.hand.push(startCard);
    cur.hasDrawn = true;
    emitEvent(io, room, `${cur.name} gave discard to ${target.name}`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("layGroup", ({ roomId, playerId, indices }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (room.handComplete) return cb({ error: "hand_complete" });
    if (!cur.hasDrawn) return cb({ error: "need_draw" });
    if (!Array.isArray(indices) || indices.length < 3) return cb({ error: "count" });
    {
      const reqs = getPhaseRequirementsForHand(room.handNumber);
      let needGroups = 0; let needRuns = 0;
      reqs.forEach((q) => { if (q.type === "group") needGroups += q.count; else needRuns += q.count; });
      if (cur.laidGroups.length >= needGroups) return cb({ error: "limit" });
    }
    const pick = indices.map((i: number) => cur.hand[i]).filter(Boolean);
    if (pick.length !== indices.length) return cb({ error: "index" });
    if (!isValidGroup(pick)) return cb({ error: "invalid" });
    const sorted = indices.slice().sort((a: number, b: number) => b - a);
    cur.laidGroups.push(pick);
    for (const i of sorted) cur.hand.splice(i, 1);
    const reqs = getPhaseRequirementsForHand(room.handNumber);
    let g = 0, r = 0;
    reqs.forEach((q) => { if (q.type === "group") g += q.count; else r += q.count; });
    cur.laidComplete = cur.laidGroups.length >= g && cur.laidRuns.length >= r;
    const txt = `Group: ${pick.map(formatCardText).join(", ")}`;
    emitEvent(io, room, `${cur.name} laid ${txt}`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("layRun", ({ roomId, playerId, indices }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (room.handComplete) return cb({ error: "hand_complete" });
    if (!cur.hasDrawn) return cb({ error: "need_draw" });
    if (!Array.isArray(indices) || indices.length < 4) return cb({ error: "count" });
    {
      const reqs = getPhaseRequirementsForHand(room.handNumber);
      let needGroups = 0; let needRuns = 0;
      reqs.forEach((q) => { if (q.type === "group") needGroups += q.count; else needRuns += q.count; });
      if (cur.laidRuns.length >= needRuns) return cb({ error: "limit" });
    }
    const pick = indices.map((i: number) => cur.hand[i]).filter(Boolean);
    if (pick.length !== indices.length) return cb({ error: "index" });
    if (!isValidRun(pick)) return cb({ error: "invalid" });
    const sorted = indices.slice().sort((a: number, b: number) => b - a);
    cur.laidRuns.push(pick);
    for (const i of sorted) cur.hand.splice(i, 1);
    const reqs = getPhaseRequirementsForHand(room.handNumber);
    let g = 0, r = 0;
    reqs.forEach((q) => { if (q.type === "group") g += q.count; else r += q.count; });
    cur.laidComplete = cur.laidGroups.length >= g && cur.laidRuns.length >= r;
    const txt = `Run: ${pick.map(formatCardText).join(" → ")}`;
    emitEvent(io, room, `${cur.name} laid ${txt}`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("hit", ({ roomId, playerId, targetId, type, index, addIndices }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const cur = room.players[room.currentIndex];
    if (cur.id !== playerId) return cb({ error: "turn" });
    if (room.handComplete) return cb({ error: "hand_complete" });
    if (!cur.laidComplete) return cb({ error: "need_laid" });
    const target = room.players.find(p => p.id === targetId);
    if (!target) return cb({ error: "target" });
    const add = addIndices.map((i: number) => cur.hand[i]).filter(Boolean);
    if (add.length !== addIndices.length) return cb({ error: "index" });
    if (type === "group") {
      const base = target.laidGroups[index];
      if (!base) return cb({ error: "slot" });
      const next = base.concat(add);
      if (!isValidGroup(next)) return cb({ error: "invalid" });
      target.laidGroups[index] = next;
    } else {
      const base = target.laidRuns[index];
      if (!base) return cb({ error: "slot" });
      const next = base.concat(add);
      if (!isValidRun(next)) return cb({ error: "invalid" });
      target.laidRuns[index] = next;
    }
    const sorted = addIndices.slice().sort((a: number, b: number) => b - a);
    for (const i of sorted) cur.hand.splice(i, 1);
    const addsText = add.map(formatCardText).join(", ");
    const label = type === "group" ? `group ${index + 1}` : `run ${index + 1}`;
    emitEvent(io, room, `${cur.name} hit ${addsText} on ${target.name}'s ${label}`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("nextHand", ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    if (!room.handComplete) return cb({ error: "not_complete" });
    if (room.handNumber >= 6) {
      cb({ error: "match_complete" });
      emitEvent(io, room, "Match complete");
      broadcast(io, room);
      setTimeout(() => closeRoomInternal(io, room, "complete"), 15000);
      return;
    }
    room.handNumber += 1;
    deal(room);
    scheduleTurnTimeout(room);
    emitEvent(io, room, `Starting next hand`);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("setTimer", ({ roomId, ms }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    const val = Number(ms);
    if (!Number.isFinite(val)) return cb({ error: "ms" });
    const clamped = Math.max(5000, Math.min(120000, Math.floor(val)));
    room.turnMs = clamped;
    scheduleTurnTimeout(room);
    broadcast(io, room);
    cb({ ok: true });
  });

  socket.on("setMatchLimit", ({ roomId, minutes }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: "not_found" });
    if (room.started) return cb({ error: "in_progress" });
    const m = Math.floor(Number(minutes) || 30);
    if (!Number.isFinite(m)) return cb({ error: "minutes" });
    const clamped = Math.max(10, Math.min(120, m));
    room.matchLimitMs = clamped * 60 * 1000;
    broadcast(io, room);
    cb({ ok: true, matchLimitMs: room.matchLimitMs });
  });

  socket.on("closeRoom", ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: "not_found" });
    const info = playerBySocket.get(socket.id) || spectatorBySocket.get(socket.id);
    if (!info || info.roomId !== room.id) return cb && cb({ error: "not_member" });
    if (room.started) return cb && cb({ error: "started" });
    const playerCount = room.players.length;
    if (playerCount > 1) return cb && cb({ error: "not_empty" });
    closeRoomInternal(io, room, "lobby_close");
    cb && cb({ ok: true });
  });

  socket.on("listRecent", (cb) => {
    cb({ items: recentMatches.slice().reverse() });
  });

  socket.on("disconnect", () => {
    const pinfo = playerBySocket.get(socket.id);
    const sinfo = spectatorBySocket.get(socket.id);
    if (pinfo) {
      const room = rooms.get(pinfo.roomId);
      if (!room) { playerBySocket.delete(socket.id); return; }
      const player = room.players.find(x => x.id === pinfo.id);
      if (!player) { playerBySocket.delete(socket.id); return; }
      playerBySocket.delete(socket.id);
      emitEvent(io, room, `${player.name} disconnected. Waiting up to 60s to reconnect...`);
      broadcast(io, room);
      const existing = disconnectTimers.get(player.id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        const idx2 = room.players.findIndex(x => x.id === player.id);
        if (idx2 < 0) { disconnectTimers.delete(player.id); return; }
        const wasCur2 = room.players[room.currentIndex]?.id === player.id;
        const [p2] = room.players.splice(idx2, 1);
        p2.ready = false;
        disconnectTimers.delete(player.id);
        if (room.started && !room.handComplete) {
          const winner = room.players[0] || null;
          const tt = turnTimers.get(room.id);
          if (tt) { clearTimeout(tt); turnTimers.delete(room.id); }
          room.turnDeadline = null;
          room.handComplete = true;
          room.lastScores = [];
          if (winner) {
            emitEvent(io, room, `${p2.name} disconnected. ${winner.name} wins by forfeit`);
            room.lastScores.push({ playerId: winner.id, name: winner.name, hand: 0, total: winner.totalScore });
          } else {
            emitEvent(io, room, `${p2.name} disconnected. Match ended`);
          }
          broadcast(io, room);
          setTimeout(() => closeRoomInternal(io, room, "forfeit"), 15000);
          return;
        }
        if (room.players.length === 0) {
          room.currentIndex = 0;
        } else if (wasCur2) {
          room.currentIndex = room.currentIndex % room.players.length;
        } else {
          const currentId2 = room.players[room.currentIndex]?.id || null;
          room.currentIndex = currentId2 ? room.players.findIndex(x => x.id === currentId2) : 0;
        }
        emitEvent(io, room, `${p2.name} left seat`);
        broadcast(io, room);
      }, 60000);
      disconnectTimers.set(player.id, t);
    } else if (sinfo) {
      const room = rooms.get(sinfo.roomId);
      spectatorBySocket.delete(socket.id);
      if (room) {
        const i = room.spectators.findIndex(s => s.id === sinfo.id);
        if (i >= 0) room.spectators.splice(i, 1);
        io.to(room.id).emit("event", { text: "Spectator disconnected", ts: Date.now() });
      }
    }
  });
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// removed duplicate connection block; disconnect handling is inside the main connection handler
