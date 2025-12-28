import { io, Socket } from "socket.io-client";
import { Card } from "../engine/card";

export type ServerRoomState = {
  id: string;
  handNumber: number;
  players: { id: string; name: string; hand: Card[]; hasDrawn: boolean; didDiscard: boolean; laidGroups: Card[][]; laidRuns: Card[][]; laidComplete: boolean; totalScore: number; ready: boolean }[];
  currentIndex: number;
  drawPile: Card[];
  discardPile: Card[];
  started: boolean;
  handComplete: boolean;
  matchOver: boolean;
  matchReason: string | null;
  lastScores: { playerId: string; name: string; hand: number; total: number }[];
  turnDeadline: number | null;
  spectators: { id: string; name: string }[];
  lobbyDeadline: number | null;
  matchDeadline: number | null;
};

export type RoomSummary = {
  id: string;
  handNumber: number;
  started: boolean;
  handComplete: boolean;
  players: { name: string; totalScore: number }[];
  spectators: number;
};

export class NetClient {
  socket: Socket | null = null;
  playerId: string | null = null;
  roomId: string | null = null;
  onState?: (s: ServerRoomState) => void;
  onEvent?: (e: { text: string; ts: number }) => void;
  onChat?: (m: { name: string; message: string; ts: number }) => void;
  onLobbyTimeout?: (d: { ts: number }) => void;
  onSpectatorJoin?: (d: { name: string }) => void;

  connect(): void {
    const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const configuredUrl = (() => {
      try {
        const v = localStorage.getItem("socketUrlOverride");
        return v && v.trim().length ? v.trim() : null;
      } catch {
        return null;
      }
    })();
    const url = configuredUrl ?? (isLocalhost && location.port && location.port !== "3001" ? `${location.protocol}//${location.hostname}:3001` : location.origin);
    this.socket = io(url, { transports: ["websocket", "polling"], reconnectionAttempts: 10, reconnectionDelay: 500 });
    this.socket.on("state", (s: ServerRoomState) => {
      if (this.onState) this.onState(s);
    });
    this.socket.on("event", (e: { text: string; ts: number }) => {
      if (this.onEvent) this.onEvent(e);
    });
    this.socket.on("chat", (m: { name: string; message: string; ts: number }) => {
      if (this.onChat) this.onChat(m);
    });
    this.socket.on("lobby_timeout", (d: { ts: number }) => {
      if (this.onLobbyTimeout) this.onLobbyTimeout(d);
    });
    this.socket.on("spectator_joined", (d: { name: string }) => {
      if (this.onSpectatorJoin) this.onSpectatorJoin(d);
    });
  }

  createRoom(name: string, minutesOrCb: number | ((roomId: string) => void), cb?: (roomId: string) => void): void {
    const minutes = typeof minutesOrCb === "number" ? minutesOrCb : undefined;
    const callback = typeof minutesOrCb === "function" ? minutesOrCb : cb;
    this.socket?.emit("createRoom", { name, matchLimitMinutes: minutes }, (res: any) => {
      this.roomId = res.roomId; this.playerId = res.playerId;
      if (callback) callback(res.roomId);
      try { localStorage.setItem("roomId", this.roomId!); localStorage.setItem("playerId", this.playerId!); } catch {}
    });
  }

  joinRoom(roomId: string, name: string, cb: (ok: boolean) => void): void {
    this.socket?.emit("joinRoom", { roomId, name }, (res: any) => {
      if (res.ok) { this.roomId = roomId; this.playerId = res.playerId; cb(true); } else cb(false);
      try { localStorage.setItem("roomId", this.roomId!); localStorage.setItem("playerId", this.playerId!); } catch {}
    });
  }

  startMatch(): void {
    if (!this.roomId) return;
    this.socket?.emit("startMatch", { roomId: this.roomId }, () => {});
  }

  restartMatch(cb?: (ok: boolean, error?: string) => void): void {
    if (!this.roomId) return cb && cb(false, "not_in_room");
    this.socket?.emit("restartMatch", { roomId: this.roomId }, (res: any) => {
      if (cb) {
        if (res && res.ok) cb(true);
        else cb(false, res?.error);
      }
    });
  }

  draw(from: "pile" | "discard"): void {
    if (!this.roomId || !this.playerId) return;
    this.socket?.emit("draw", { roomId: this.roomId, playerId: this.playerId, from }, () => {});
  }

  discard(index: number, cb?: (ok: boolean) => void): void {
    if (!this.roomId || !this.playerId) return cb && cb(false);
    this.socket?.emit("discard", { roomId: this.roomId, playerId: this.playerId, index }, (res: any) => {
      if (cb) cb(!!(res && res.ok));
    });
  }

  endTurn(): void {
    if (!this.roomId || !this.playerId) return;
    this.socket?.emit("endTurn", { roomId: this.roomId, playerId: this.playerId }, () => {});
  }

  giveDiscardTo(targetId: string): void {
    if (!this.roomId || !this.playerId) return;
    this.socket?.emit("giveDiscardTo", { roomId: this.roomId, playerId: this.playerId, targetId }, () => {});
  }

  resetHand(cb?: (ok: boolean, error?: string) => void): void {
    if (!this.roomId) return cb && cb(false, "not_in_room");
    if (!this.socket || !this.socket.connected) return cb && cb(false, "disconnected");
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      cb && cb(false, "timeout");
    }, 1200);
    this.socket.emit("resetHand", { roomId: this.roomId }, (res: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (cb) {
        if (res && res.ok) cb(true);
        else cb(false, res?.error);
      }
    });
  }

  finishHand(cb?: (ok: boolean, error?: string) => void): void {
    if (!this.roomId) return cb && cb(false, "not_in_room");
    if (!this.socket || !this.socket.connected) return cb && cb(false, "disconnected");
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      cb && cb(false, "timeout");
    }, 1200);
    this.socket.emit("finishHand", { roomId: this.roomId }, (res: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (cb) {
        if (res && res.ok) cb(true);
        else cb(false, res?.error);
      }
    });
  }

  layGroup(indices: number[], cb?: (ok: boolean, err?: string) => void): void {
    if (!this.roomId || !this.playerId) return cb && cb(false, "not_in_room");
    this.socket?.emit("layGroup", { roomId: this.roomId, playerId: this.playerId, indices }, (res: any) => {
      if (cb) cb(!!(res && res.ok), res?.error);
    });
  }

  layRun(indices: number[], cb?: (ok: boolean, err?: string) => void): void {
    if (!this.roomId || !this.playerId) return cb && cb(false, "not_in_room");
    this.socket?.emit("layRun", { roomId: this.roomId, playerId: this.playerId, indices }, (res: any) => {
      if (cb) cb(!!(res && res.ok), res?.error);
    });
  }

  hit(targetId: string, type: "group" | "run", index: number, addIndices: number[]): void {
    if (!this.roomId || !this.playerId) return;
    this.socket?.emit("hit", { roomId: this.roomId, playerId: this.playerId, targetId, type, index, addIndices }, () => {});
  }

  reorderHand(fromIndex: number, toIndex: number): void {
    if (!this.roomId || !this.playerId) return;
    this.socket?.emit("reorderHand", { roomId: this.roomId, playerId: this.playerId, fromIndex, toIndex }, () => {});
  }

  nextHand(cb?: (ok: boolean, error?: string) => void): void {
    if (!this.roomId) return;
    this.socket?.emit("nextHand", { roomId: this.roomId }, (res: any) => {
      if (cb) {
        if (res && res.ok) cb(true);
        else cb(false, res?.error);
      }
    });
  }

  setTimer(ms: number): void {
    if (!this.roomId) return;
    this.socket?.emit("setTimer", { roomId: this.roomId, ms }, () => {});
  }

  spectate(roomId: string, name: string, cb: (ok: boolean) => void): void {
    this.socket?.emit("spectateRoom", { roomId, name }, (res: any) => {
      if (res && res.ok) { this.roomId = roomId; this.playerId = null; cb(true); } else cb(false);
      try { localStorage.setItem("roomId", this.roomId!); localStorage.removeItem("playerId"); } catch {}
    });
  }

  resumeFromStorage(): void {
    try {
      const r = localStorage.getItem("roomId");
      const p = localStorage.getItem("playerId");
      if (r && p) {
        this.socket?.emit("resume", { roomId: r, playerId: p }, (res: any) => {
          if (res && res.ok) { this.roomId = r; this.playerId = p; }
        });
      }
    } catch {}
  }

  chat(message: string): void {
    if (!this.roomId) return;
    this.socket?.emit("chat", { roomId: this.roomId, playerId: this.playerId, message }, () => {});
  }

  leaveSeat(cb?: (ok: boolean) => void): void {
    if (!this.roomId || !this.playerId) return cb && cb(false);
    this.socket?.emit("leaveSeat", { roomId: this.roomId, playerId: this.playerId }, (res: any) => {
      if (res && res.ok) { this.playerId = null; try { localStorage.removeItem("playerId"); } catch {} if (cb) cb(true); } else if (cb) cb(false);
    });
  }

  takeSeat(name: string, cb: (ok: boolean) => void): void {
    if (!this.roomId) return cb(false);
    this.socket?.emit("takeSeat", { roomId: this.roomId, name }, (res: any) => {
      if (res && res.ok) { this.playerId = res.playerId; try { localStorage.setItem("playerId", this.playerId!); } catch {} cb(true); } else cb(false);
    });
  }

  resumeById(roomId: string, playerId: string, cb: (ok: boolean) => void): void {
    this.socket?.emit("resume", { roomId, playerId }, (res: any) => {
      if (res && res.ok) { this.roomId = roomId; this.playerId = playerId; cb(true); } else cb(false);
    });
  }

  switchSeat(toIndex: number): void {
    if (!this.roomId || !this.playerId) return;
    this.socket?.emit("switchSeat", { roomId: this.roomId, playerId: this.playerId, toIndex }, () => {});
  }

  listRooms(cb: (rooms: RoomSummary[]) => void): void {
    this.socket?.emit("listRooms", (res: any) => {
      cb(res.rooms || []);
    });
  }

  takeSeatAt(name: string, toIndex: number, cb: (ok: boolean) => void): void {
    if (!this.roomId) return cb(false);
    this.socket?.emit("takeSeatAt", { roomId: this.roomId, name, toIndex }, (res: any) => {
      if (res && res.ok) { this.playerId = res.playerId; try { localStorage.setItem("playerId", this.playerId!); } catch {} cb(true); } else cb(false);
    });
  }

  setReady(ready: boolean, cb?: (ok: boolean) => void): void {
    if (!this.roomId) return cb && cb(false);
    this.socket?.emit("setReady", { roomId: this.roomId, playerId: this.playerId, ready }, (res: any) => {
      if (cb) cb(!!(res && res.ok));
    });
  }

  setSeatReady(seatIndex: number, ready: boolean, cb?: (ok: boolean) => void): void {
    if (!this.roomId) return cb && cb(false);
    this.socket?.emit("setSeatReady", { roomId: this.roomId, seatIndex, ready }, (res: any) => {
      if (cb) cb(!!(res && res.ok));
    });
  }

  extendLobby(addSeconds = 30, cb?: (ok: boolean, deadline?: number) => void): void {
    if (!this.roomId) return cb && cb(false);
    this.socket?.emit("extendLobby", { roomId: this.roomId, addMs: addSeconds * 1000 }, (res: any) => {
      if (cb) cb(!!(res && res.ok), res?.lobbyDeadline);
    });
  }

  leaveRoom(cb?: (ok: boolean) => void): void {
    try { localStorage.removeItem("roomId"); localStorage.removeItem("playerId"); } catch {}
    this.roomId = null;
    this.playerId = null;
    if (this.socket) {
      try { this.socket.disconnect(); } catch {}
      this.socket = null;
    }
    this.connect();
    if (cb) cb(true);
  }

  closeRoom(cb?: (ok: boolean) => void): void {
    if (!this.roomId) return cb && cb(false);
    this.socket?.emit("closeRoom", { roomId: this.roomId }, (res: any) => {
      if (cb) cb(!!(res && res.ok));
    });
  }

  setMatchLimit(minutes: number, cb?: (ok: boolean, ms?: number) => void): void {
    if (!this.roomId) return cb && cb(false);
    this.socket?.emit("setMatchLimit", { roomId: this.roomId, minutes }, (res: any) => {
      if (cb) cb(!!(res && res.ok), res?.matchLimitMs);
    });
  }

  listRecent(cb: (items: { id: string; ended: number; reason: string; players: { name: string; totalScore: number }[] }[]) => void): void {
    this.socket?.emit("listRecent", (res: any) => {
      cb(res?.items || []);
    });
  }
}
