import { createDoubleDeck, Card } from "../engine/card";
import { Deck } from "../engine/deck";
import { getDealCountForHand, getPhaseRequirementsForHand, PhaseRequirement } from "../engine/game";
import { NetClient, ServerRoomState, RoomSummary } from "./net";
import { scoreHand } from "../engine/scoring";
import { isValidGroup, isValidRun } from "../engine/rules";

type Player = { id: number; serverId?: string; name: string; hand: Card[]; hasDrawn: boolean; didDiscard: boolean; laidGroups: Card[][]; laidRuns: Card[][]; laidComplete: boolean; totalScore: number };

type State = {
  handNumber: number;
  players: Player[];
  current: number;
  drawPile: Deck;
  discardPile: Card[];
  selectedIndices: number[];
  matchComplete: boolean;
  netMode: boolean;
  net?: NetClient;
  lastScores: { playerId: string; name: string; hand: number; total: number }[];
  turnDeadline: number | null;
  matchDeadline?: number | null;
  stage: "title" | "profile" | "find" | "lobby" | "game" | "hand_results" | "match_summary" | "settings" | "help";
  rooms: RoomSummary[];
  filter: "all" | "lobby" | "active" | "complete";
  chatOpen: boolean;
  chatUnread: number;
  prevStage?: "title" | "profile" | "find" | "lobby" | "game" | "hand_results" | "match_summary" | "settings" | "help";
  lobbyDeadline?: number | null;
};

type AppSettings = { theme: "light" | "dark"; textSize: "md" | "lg"; highContrast: boolean };

function formatCard(c: Card): string {
  if (c.rank === "Joker") return "Joker";
  if (!c.suit) return String(c.rank);
  return `${c.rank} ${c.suit}`;
}

function rankLabel(r: Card["rank"]): string {
  if (typeof r === "number") return String(r);
  if (r === "J") return "Jack";
  if (r === "Q") return "Queen";
  if (r === "K") return "King";
  if (r === "A") return "Ace";
  if (r === "Joker") return "Joker";
  return String(r);
}

function cardImagePath(c: Card): string {
  if (c.rank === "Joker") return "Card Game Assets/Cards/Joker Card.png";
  if (!c.suit) return "";
  const rl = rankLabel(c.rank);
  return `Card Game Assets/Cards/${rl} of ${c.suit} Card.png`;
}

function cardImageCandidates(c: Card): string[] {
  if (c.rank === "Joker") return [
    "Card Game Assets/Cards/Joker Card.png",
    "Card Game Assets/Cards/Joker.png",
  ];
  if (!c.suit) return [];
  const rl = rankLabel(c.rank);
  const suitVars = [c.suit, c.suit.toLowerCase()];
  const out: string[] = [];
  for (const sv of suitVars) {
    const base = `Card Game Assets/Cards/${rl} of ${sv}`;
    out.push(`${base} Card.png`);
    out.push(`${base}.png`);
  }
  return out;
}

function cardBackPath(): string {
  return "Card Game Assets/Cards/Branded Card Back.png";
}

function loadImageWithFallback(img: HTMLImageElement, c: Card, onFail: () => void): void {
  const cand = cardImageCandidates(c);
  let i = 0;
  const tryNext = () => {
    if (i >= cand.length) { onFail(); return; }
    img.src = cand[i++];
  };
  img.onerror = () => tryNext();
  tryNext();
}

function setBackgroundCard(el: HTMLElement, c: Card): void {
  const cand = cardImageCandidates(c);
  let i = 0;
  const probe = new Image();
  const tryNext = () => {
    if (i >= cand.length) { el.textContent = formatCard(c); return; }
    probe.src = cand[i++];
  };
  probe.onload = () => {
    el.classList.add("flip");
    if (el.id === "discard-top") {
      el.style.backgroundImage = `url('${cardBackPath()}')`;
      setTimeout(() => { el.style.backgroundImage = `url('${probe.src}')`; }, 150);
    } else {
      el.style.backgroundImage = `url('${probe.src}')`;
    }
    el.style.backgroundSize = "contain";
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundPosition = "center";
    setTimeout(() => el.classList.remove("flip"), 300);
  };
  probe.onerror = () => tryNext();
  tryNext();
}

function initPlayers(count: number, deck: Deck, handNumber: number): Player[] {
  const players: Player[] = [];
  const deal = getDealCountForHand(handNumber);
  for (let i = 0; i < count; i++) {
    const hand: Card[] = [];
    for (let j = 0; j < deal; j++) {
      const c = deck.draw();
      if (!c) throw new Error("no cards");
      hand.push(c);
    }
    players.push({ id: i, name: `Player ${i + 1}`, hand, hasDrawn: false, didDiscard: false, laidGroups: [], laidRuns: [], laidComplete: false, totalScore: 0 });
  }
  return players;
}

function createState(): State {
  const deck = new Deck(createDoubleDeck(true));
  deck.shuffle();
  const handNumber = 1;
  const players = initPlayers(2, deck, handNumber);
  const discardFirst = deck.draw();
  if (!discardFirst) throw new Error("no discard");
  return {
    handNumber,
    players,
    current: 0,
    drawPile: deck,
    discardPile: [discardFirst],
    selectedIndices: [],
    matchComplete: false,
    netMode: false,
    lastScores: [],
    turnDeadline: null,
    stage: "title",
    rooms: [],
    filter: "all",
    chatOpen: false,
    chatUnread: 0,
  };
}

let state: State = createState();

const elPlayers = document.getElementById("players") as HTMLElement;
const elDrawSize = document.getElementById("draw-size") as HTMLElement;
const elDiscardTop = document.getElementById("discard-top") as HTMLElement;
const elBtnDraw = document.getElementById("btn-draw") as HTMLButtonElement;
const elBtnDrawDiscard = document.getElementById("btn-draw-discard") as HTMLButtonElement;
const elBtnDiscard = document.getElementById("btn-discard") as HTMLButtonElement;
const elBtnEnd = document.getElementById("btn-end") as HTMLButtonElement;
const elSelTarget = document.getElementById("sel-target") as HTMLSelectElement;
const elBtnGive = document.getElementById("btn-give") as HTMLButtonElement;
const elBtnLayGroup = document.getElementById("btn-lay-group") as HTMLButtonElement;
const elBtnLayRun = document.getElementById("btn-lay-run") as HTMLButtonElement;
const elBtnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const elStatus = document.getElementById("status") as HTMLElement;
const elHitPlayer = document.getElementById("sel-hit-player") as HTMLSelectElement;
const elHitType = document.getElementById("sel-hit-type") as HTMLSelectElement;
const elHitIndex = document.getElementById("sel-hit-index") as HTMLSelectElement;
const elBtnHit = document.getElementById("btn-hit") as HTMLButtonElement;
const elScoreboard = document.getElementById("scoreboard") as HTMLElement;
const elScores = document.getElementById("scores") as HTMLElement;
const elBtnNextHand = document.getElementById("btn-next-hand") as HTMLButtonElement;
const elRecentList = document.getElementById("recent-list") as HTMLElement;
const elMpName = document.getElementById("mp-name") as HTMLInputElement;
const elMpCreate = document.getElementById("mp-create") as HTMLButtonElement;
const elMpRoom = document.getElementById("mp-room") as HTMLInputElement;
const elMpJoin = document.getElementById("mp-join") as HTMLButtonElement;
const elMpSpectate = document.getElementById("mp-spectate") as HTMLButtonElement;
const elMpStart = document.getElementById("mp-start") as HTMLButtonElement;
const elMpInfo = document.getElementById("mp-info") as HTMLElement;
const elMpTimer = document.getElementById("mp-timer") as HTMLInputElement;
const elMpSetTimer = document.getElementById("mp-set-timer") as HTMLButtonElement;
const elMpCopy = document.getElementById("mp-copy") as HTMLButtonElement;
const elMpLeave = document.getElementById("mp-leave") as HTMLButtonElement;
const elMpTake = document.getElementById("mp-take") as HTMLButtonElement;
const elMpPlayer = document.getElementById("mp-player") as HTMLInputElement;
const elMpResume = document.getElementById("mp-resume") as HTMLButtonElement;
const elMpSeat = document.getElementById("mp-seat") as HTMLInputElement;
const elMpSwitch = document.getElementById("mp-switch") as HTMLButtonElement;
const elBtnBrowse = document.getElementById("btn-browse") as HTMLButtonElement;
const elBtnRefresh = document.getElementById("btn-refresh") as HTMLButtonElement;
const elSelMatch = document.getElementById("sel-match") as HTMLSelectElement;
const elBtnWatch = document.getElementById("btn-watch") as HTMLButtonElement;
const elEventLog = document.getElementById("event-log") as HTMLElement;
const elSpectators = document.getElementById("spectators") as HTMLElement;
const elChatLog = document.getElementById("chat-log") as HTMLElement;
const elChatInput = document.getElementById("chat-input") as HTMLInputElement;
const elChatSend = document.getElementById("chat-send") as HTMLButtonElement;
const elBtnPlay = document.getElementById("btn-play") as HTMLButtonElement;
const elHeader = document.getElementById("app-header") as HTMLElement;
const elMain = document.getElementById("app-main") as HTMLElement;
const elPageTitle = document.getElementById("page-title") as HTMLElement;
const elPageProfile = document.getElementById("page-profile") as HTMLElement;
const elPageFind = document.getElementById("page-find") as HTMLElement;
const elPageLobby = document.getElementById("page-lobby") as HTMLElement;
const elPageSummary = document.getElementById("page-summary") as HTMLElement;
const elPageHandResults = document.getElementById("page-hand-results") as HTMLElement;
const elHrTitle = document.getElementById("hr-title") as HTMLElement;
const elHrSub = document.getElementById("hr-sub") as HTMLElement;
const elHrTbody = document.getElementById("hr-tbody") as HTMLElement;
const elMsTbody = document.getElementById("ms-tbody") as HTMLElement;
const elBtnHandBack = document.getElementById("btn-hand-back") as HTMLButtonElement;
const elPageSettings = document.getElementById("page-settings") as HTMLElement;
const elPageHelp = document.getElementById("page-help") as HTMLElement;
const elPageGame = document.getElementById("page-game") as HTMLElement;
const elHandGrid = document.getElementById("hand-grid") as HTMLElement;
const elTimerHours = document.getElementById("timer-hours") as HTMLElement;
const elTimerMinutes = document.getElementById("timer-minutes") as HTMLElement;
const elTimerSeconds = document.getElementById("timer-seconds") as HTMLElement;
const elBtnToggleChat = document.getElementById("btn-toggle-chat") as HTMLButtonElement;
const elBtnCloseChat = document.getElementById("btn-close-chat") as HTMLButtonElement;
const elChatPanel = document.getElementById("chat-panel") as HTMLElement;
const elChatUnread = document.getElementById("chat-unread") as HTMLElement;
const elNameEntry = document.getElementById("name-entry") as HTMLInputElement;
const elBtnNameContinue = document.getElementById("btn-name-continue") as HTMLButtonElement;
const elBtnTitlePlay = document.getElementById("btn-title-play") as HTMLButtonElement;
const elBtnTitleSettings = document.getElementById("btn-title-settings") as HTMLButtonElement;
const elBtnTitleHelp = document.getElementById("btn-title-help") as HTMLButtonElement;
const elBtnFindCreate = document.getElementById("btn-find-create") as HTMLButtonElement;
const elBtnFindJoin = document.getElementById("btn-find-join") as HTMLButtonElement;
const elFindRoomId = document.getElementById("find-room-id") as HTMLInputElement;
const elFindList = document.getElementById("find-list") as HTMLElement;
const elBtnFindRefresh = document.getElementById("btn-find-refresh") as HTMLButtonElement;
const elLobbyRoomId = document.getElementById("lobby-room-id") as HTMLElement;
const elBtnCopyRoom = document.getElementById("btn-copy-room") as HTMLButtonElement;
const elSlot1Status = document.getElementById("slot1-status") as HTMLElement;
const elSlot2Status = document.getElementById("slot2-status") as HTMLElement;
const elBtnSlot1Take = document.getElementById("btn-slot1-take") as HTMLButtonElement;
const elBtnSlot1Leave = document.getElementById("btn-slot1-leave") as HTMLButtonElement;
const elBtnSlot2Take = document.getElementById("btn-slot2-take") as HTMLButtonElement;
const elBtnSlot2Leave = document.getElementById("btn-slot2-leave") as HTMLButtonElement;
const elSlot1Ready = document.getElementById("slot1-ready") as HTMLElement;
const elSlot2Ready = document.getElementById("slot2-ready") as HTMLElement;
const elBtnSlot1Ready = document.getElementById("btn-slot1-ready") as HTMLButtonElement;
const elBtnSlot2Ready = document.getElementById("btn-slot2-ready") as HTMLButtonElement;
const elBtnLobbyStart = document.getElementById("btn-lobby-start") as HTMLButtonElement;
const elLobbyStatus = document.getElementById("lobby-status") as HTMLElement;
const elLobbyReadyChip = document.getElementById("lobby-ready-chip") as HTMLElement;
const elLobbyTimer = document.getElementById("lobby-timer") as HTMLElement;
const elBtnLobbyExtend = document.getElementById("btn-lobby-extend") as HTMLButtonElement;
const elLobbyChatLog = document.getElementById("lobby-chat-log") as HTMLElement;
const elLobbyChatInput = document.getElementById("lobby-chat-input") as HTMLInputElement;
const elLobbyChatSend = document.getElementById("lobby-chat-send") as HTMLButtonElement;
const elBtnSettingsBack = document.getElementById("btn-settings-back") as HTMLButtonElement;
const elBtnSaveSettings = document.getElementById("btn-save-settings") as HTMLButtonElement;
const elBtnHelpBack = document.getElementById("btn-help-back") as HTMLButtonElement;
const elBtnPlayAgain = document.getElementById("btn-play-again") as HTMLButtonElement;
const elBtnReturnMenu = document.getElementById("btn-return-menu") as HTMLButtonElement;
const elBtnLobbyLeave = document.getElementById("btn-lobby-leave") as HTMLButtonElement;
const elBtnMatchLeave = document.getElementById("btn-match-leave") as HTMLButtonElement;
const elMpTakeAt = document.getElementById("mp-take-at") as HTMLButtonElement;
const elSelFilter = document.getElementById("sel-filter") as HTMLSelectElement;
const elChkAuto = document.getElementById("chk-auto") as HTMLInputElement;
const elOptTheme = document.getElementById("opt-theme") as HTMLSelectElement;
const elOptTextSize = document.getElementById("opt-text-size") as HTMLSelectElement;
const elOptHighContrast = document.getElementById("opt-high-contrast") as HTMLInputElement;

let toastEl: HTMLElement | null = null;
let toastTimer: any = null;
function showToast(text: string): void {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.style.position = "fixed";
    toastEl.style.top = "16px";
    toastEl.style.left = "50%";
    toastEl.style.transform = "translateX(-50%)";
    toastEl.style.background = "#111829";
    toastEl.style.color = "#fff";
    toastEl.style.padding = "10px 14px";
    toastEl.style.borderRadius = "10px";
    toastEl.style.boxShadow = "0 6px 18px rgba(0,0,0,0.25)";
    toastEl.style.zIndex = "9999";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = "none"; }, 2500);
}

let lobbyTimerHandle: any = null;
function startLobbyCountdown(): void {
  if (lobbyTimerHandle) clearInterval(lobbyTimerHandle);
  lobbyTimerHandle = setInterval(() => {
    if (state.stage !== "lobby") { clearInterval(lobbyTimerHandle); lobbyTimerHandle = null; return; }
    let dl = state.lobbyDeadline || 0;
    if (!dl) { dl = Date.now() + 120000; state.lobbyDeadline = dl; }
    const remain = Math.max(0, Math.ceil((dl - Date.now()) / 1000));
    const m = Math.floor(remain / 60);
    const s = remain % 60;
    if (elLobbyTimer) elLobbyTimer.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (remain <= 0) { clearInterval(lobbyTimerHandle); lobbyTimerHandle = null; }
  }, 1000);
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("appSettings");
    let s: AppSettings;
    if (raw) s = normalizeSettings(JSON.parse(raw));
    else s = { theme: "dark", textSize: "md", highContrast: false };
    if (elOptTheme) elOptTheme.value = s.theme;
    if (elOptTextSize) elOptTextSize.value = s.textSize;
    if (elOptHighContrast) elOptHighContrast.checked = s.highContrast;
    applySettings(s);
    return s;
  } catch {
    const s2: AppSettings = { theme: "dark", textSize: "md", highContrast: false };
    applySettings(s2);
    return s2;
  }
}

function applySettings(s: AppSettings): void {
  document.documentElement.classList.toggle("dark", s.theme === "dark");
  document.documentElement.setAttribute("data-text-size", s.textSize);
  document.documentElement.classList.toggle("hc", s.highContrast);
}

function render(): void {
  elPageTitle.classList.toggle("hidden", state.stage !== "title");
  elPageProfile.classList.toggle("hidden", state.stage !== "profile");
  elPageFind.classList.toggle("hidden", state.stage !== "find");
  elPageLobby.classList.toggle("hidden", state.stage !== "lobby");
  elPageSummary.classList.toggle("hidden", state.stage !== "match_summary");
  elPageHandResults.classList.toggle("hidden", state.stage !== "hand_results");
  elPageSettings.classList.toggle("hidden", state.stage !== "settings");
  elPageHelp.classList.toggle("hidden", state.stage !== "help");
  elHeader.style.display = "none";
  elPageGame.classList.toggle("hidden", state.stage !== "game");
  elMain.classList.add("hidden");
  elDrawSize.textContent = `${state.drawPile.size()} cards`;
  const top = state.discardPile[state.discardPile.length - 1];
  const discEl = elDiscardTop as HTMLElement;
  const nextKey = top ? `${String(top.rank)}-${String(top.suit || "")}` : "empty";
  const prevKey = discEl.dataset.key || "";
  if (!top) {
    discEl.dataset.key = "empty";
    discEl.classList.add("discard-empty");
    discEl.textContent = "";
    discEl.style.backgroundImage = "url('Card Game Assets/Cards/Branded Card Back.png')";
  } else if (nextKey !== prevKey) {
    discEl.classList.remove("discard-empty");
    discEl.dataset.key = nextKey;
    setBackgroundCard(discEl, top);
  }
  elPlayers.innerHTML = "";
  for (const p of state.players) {
    const container = document.createElement("div");
    container.className = "player";
    const title = document.createElement("div");
    title.className = "row";
    const left = document.createElement("div");
    const laidInfo = ` | Laid: G${p.laidGroups.length} R${p.laidRuns.length} | Total ${p.totalScore}`;
    const sid = state.netMode && p.serverId ? ` (${p.serverId.slice(0, 6)})` : "";
    left.textContent = `${p.name}${sid}${state.current === p.id ? " • Turn" : ""}${laidInfo}`;
    const right = document.createElement("div");
    right.textContent = `Points in hand: ${scoreHand(p.hand)}`;
    title.appendChild(left);
    title.appendChild(right);
    const handEl = document.createElement("div");
    handEl.className = "hand";
    p.hand.forEach((c, idx) => {
      const cardEl = document.createElement("div");
      const isSel = state.current === p.id && state.selectedIndices.includes(idx);
      cardEl.className = "card" + (isSel ? " selected" : "");
      const img = document.createElement("img");
      img.alt = formatCard(c);
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "contain";
      loadImageWithFallback(img, c, () => {
        cardEl.textContent = formatCard(c);
        img.remove();
      });
      cardEl.onclick = () => {
        if (state.current !== p.id) return;
        const pos = state.selectedIndices.indexOf(idx);
        if (pos >= 0) state.selectedIndices.splice(pos, 1); else state.selectedIndices.push(idx);
        render();
      };
      cardEl.appendChild(img);
      handEl.appendChild(cardEl);
    });
    container.appendChild(title);
    container.appendChild(handEl);
    elPlayers.appendChild(container);
  }
  if (state.netMode && state.matchComplete && Array.isArray(state.lastScores) && (state as any).scorePopShownHand !== state.handNumber) {
    (state as any).scorePopShownHand = state.handNumber;
    state.lastScores.forEach((s) => {
      const idx = state.players.findIndex(pp => pp.serverId === s.playerId);
      const target = (elPlayers.children[idx] as HTMLElement) || null;
      if (!target) return;
      const pop = document.createElement("div");
      const cls = s.hand === 0 ? "text-score-green" : (s.hand <= 10 ? "text-score-yellow" : "text-score-red");
      pop.className = `score-pop ${cls}`;
      pop.textContent = `+${s.hand}`;
      target.appendChild(pop);
      setTimeout(() => { pop.remove(); }, 1800);
    });
  }
  const myId = (state.net as NetClient)?.playerId || null;
  const isSpectator = state.netMode && !myId;
  const myIdx = !isSpectator && myId ? state.players.findIndex(pp => pp.serverId === myId) : -1;
  const my = myIdx >= 0 ? state.players[myIdx] : state.players[state.current];
  const myTurn = myIdx >= 0 && state.current === myIdx;
  elBtnDraw.disabled = isSpectator || !myTurn || my.hasDrawn;
  elBtnDrawDiscard.disabled = isSpectator || !myTurn || my.hasDrawn || state.discardPile.length === 0;
  elBtnDiscard.disabled = isSpectator || !myTurn || !my.hasDrawn || state.selectedIndices.length !== 1;
  elBtnEnd.disabled = isSpectator || !myTurn || !my.hasDrawn || !my.didDiscard;
  const curName = state.players[state.current]?.name || "Player";
  elStatus.textContent = `Hand ${state.handNumber} — Deal ${getDealCountForHand(state.handNumber)} • Turn: ${curName}`;
  elSelTarget.innerHTML = "";
  state.players.forEach(p => {
    const opt = document.createElement("option");
    opt.value = state.netMode ? String(p.serverId) : String(p.id);
    opt.textContent = p.name;
    elSelTarget.appendChild(opt);
  });
  elBtnGive.disabled = isSpectator || state.discardPile.length === 0;
  elHitPlayer.innerHTML = "";
  state.players.forEach(p => {
    const opt = document.createElement("option");
    opt.value = state.netMode && p.serverId ? String(p.serverId) : String(p.id);
    opt.textContent = p.name;
    elHitPlayer.appendChild(opt);
  });
  elHitIndex.innerHTML = "";
  const targetVal = elHitPlayer.value || "0";
  const target = state.netMode ? state.players.find(p => p.serverId === targetVal) || state.players[0] : state.players.find(p => p.id === Number(targetVal)) || state.players[0];
  const type = elHitType.value;
  const count = type === "group" ? target.laidGroups.length : target.laidRuns.length;
  if (count === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "None";
    opt.disabled = true;
    opt.selected = true;
    elHitIndex.appendChild(opt);
    elHitIndex.disabled = true;
  } else {
    elHitIndex.disabled = false;
    for (let i = 0; i < count; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = String(i + 1);
      elHitIndex.appendChild(opt);
    }
  }
  elBtnHit.disabled = isSpectator || state.selectedIndices.length === 0 || !state.players[state.current].laidComplete;
  elScoreboard.style.display = state.matchComplete || state.netMode && state.lastScores.length > 0 ? "block" : "none";
  if (state.netMode && state.lastScores.length > 0) {
    elScores.innerHTML = state.lastScores.map(s => {
      const hcls = s.hand === 0 ? "text-score-green" : (s.hand <= 10 ? "text-score-yellow" : "text-score-red");
      const tcls = s.total <= 20 ? "text-score-green" : (s.total <= 60 ? "text-score-yellow" : "text-score-red");
      return `${s.name}: <span class='${hcls}'>Hand ${s.hand}</span> | <span class='${tcls}'>Total ${s.total}</span>`;
    }).join("<br>");
  }
  if (state.netMode) {
    const s = state.net as NetClient;
    let timerText = "";
    if (state.turnDeadline) {
      const sec = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
      timerText = ` • Turn: ${sec}s`;
    }
    if ((state as any).matchDeadline) {
      const sec2 = Math.max(0, Math.ceil(((state as any).matchDeadline - Date.now()) / 1000));
      const m2 = Math.floor(sec2 / 60);
      const s2 = sec2 % 60;
      timerText += ` • Match: ${String(m2).padStart(2, "0")}:${String(s2).padStart(2, "0")}`;
    }
    elMpInfo.textContent = `Room: ${s.roomId}${timerText}`;
    if ((state as any).spectators && Array.isArray((state as any).spectators)) {
      const specs = (state as any).spectators as { id: string; name: string }[];
      elSpectators.innerHTML = specs.length ? specs.map(x => x.name).join(", ") : "None";
    }
  }

  const dd = (state as any).matchDeadline || state.turnDeadline || null;
  if (dd) {
    const totalSec = Math.max(0, Math.ceil((dd - Date.now()) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (elTimerHours) elTimerHours.textContent = String(h).padStart(2, "0");
    if (elTimerMinutes) elTimerMinutes.textContent = String(m).padStart(2, "0");
    if (elTimerSeconds) elTimerSeconds.textContent = String(s).padStart(2, "0");
  } else {
    if (elTimerHours) elTimerHours.textContent = "00";
    if (elTimerMinutes) elTimerMinutes.textContent = "00";
    if (elTimerSeconds) elTimerSeconds.textContent = "00";
  }

  if (elHandGrid) {
    elHandGrid.innerHTML = "";
    const myIdX = (state.net as NetClient)?.playerId || null;
    const isSpectatorX = state.netMode && !myIdX;
    const myIdxX = !isSpectatorX && myIdX ? state.players.findIndex(pp => pp.serverId === myIdX) : -1;
    const viewerIdx = myIdxX >= 0 ? myIdxX : state.current;
    const p = state.players[viewerIdx];
    p.hand.forEach((c, idx) => {
      const outer = document.createElement("div");
      const isSel = state.current === p.id && state.selectedIndices.includes(idx);
      outer.className = "flex flex-col gap-3" + (isSel ? " transform -translate-y-4" : "");
      const inner = document.createElement("div");
      inner.className = "w-full bg-center bg-no-repeat aspect-[3/4] bg-cover rounded-lg shadow-md hover:shadow-2xl hover:-translate-y-2 hover:ring-2 hover:ring-primary/40 transition-all" + (isSel ? " ring-4 ring-primary" : "");
      setBackgroundCard(inner, c);
      inner.onclick = () => {
        if (state.current !== p.id) return;
        const pos = state.selectedIndices.indexOf(idx);
        if (pos >= 0) state.selectedIndices.splice(pos, 1); else state.selectedIndices.push(idx);
        render();
      };
      outer.appendChild(inner);
      elHandGrid.appendChild(outer);
    });
  }

  const myIdSel = (state.net as NetClient)?.playerId || null;
  const isSpectatorSel = state.netMode && !myIdSel;
  const myIdxSel = !isSpectatorSel && myIdSel ? state.players.findIndex(pp => pp.serverId === myIdSel) : -1;
  const myTurnSel = myIdxSel >= 0 && state.current === myIdxSel;
  const curSel = myTurnSel ? state.selectedIndices.map(i => state.players[myIdxSel].hand[i]) : [];
  const canGroup = curSel.length >= 3 && isValidGroup(curSel);
  const canRun = curSel.length >= 4 && isValidRun(curSel);
  if (elBtnLayGroup) {
    elBtnLayGroup.disabled = !canGroup;
    elBtnLayGroup.classList.toggle("bg-primary", canGroup);
    elBtnLayGroup.classList.toggle("text-white", canGroup);
    elBtnLayGroup.classList.toggle("bg-white", !canGroup);
    elBtnLayGroup.classList.toggle("text-gray-800", !canGroup);
  }
  if (elBtnLayRun) {
    elBtnLayRun.disabled = !canRun;
    elBtnLayRun.classList.toggle("bg-primary", canRun);
    elBtnLayRun.classList.toggle("text-white", canRun);
    elBtnLayRun.classList.toggle("bg-white", !canRun);
    elBtnLayRun.classList.toggle("text-gray-800", !canRun);
  }
  const isHitValid = (() => {
    const myIdH = (state.net as NetClient)?.playerId || null;
    const isSpectatorH = state.netMode && !myIdH;
    const myIdxH = !isSpectatorH && myIdH ? state.players.findIndex(pp => pp.serverId === myIdH) : -1;
    const myTurnH = myIdxH >= 0 && state.current === myIdxH;
    const cur = myTurnH ? state.players[myIdxH] : state.players[state.current];
    if (!myTurnH) return false;
    if (!cur.laidComplete || state.selectedIndices.length === 0) return false;
    if (state.netMode) return state.selectedIndices.length > 0; // server validates
    const targetId = Number(elHitPlayer.value || "0");
    const target = state.players.find(p => p.id === targetId);
    if (!target) return false;
    const idx = Number(elHitIndex.value || "0");
    const add = curSel;
    if (elHitType.value === "group") {
      const base = target.laidGroups[idx];
      if (!base) return false;
      return isValidGroup(base.concat(add));
    } else {
      const base = target.laidRuns[idx];
      if (!base) return false;
      return isValidRun(base.concat(add));
    }
  })();
  if (elBtnHit) {
    elBtnHit.disabled = !isHitValid;
    elBtnHit.classList.toggle("bg-primary", isHitValid);
    elBtnHit.classList.toggle("text-white", isHitValid);
    elBtnHit.classList.toggle("bg-white", !isHitValid);
    elBtnHit.classList.toggle("text-gray-800", !isHitValid);
  }
  if (state.stage === "hand_results") {
    renderHandResults();
  }
  if (state.stage === "match_summary") {
    renderMatchSummary();
  }
}

function renderHandResults(): void {
  if (!elHrTbody) return;
  elHrTbody.innerHTML = "";
  if (elHrTitle) elHrTitle.textContent = `Hand ${state.handNumber} Score`;
  const me = state.netMode ? (state.net as NetClient).playerId : null;
  state.lastScores.forEach(s => {
    const tr = document.createElement("tr");
    tr.className = "border-t border-t-gray-300 dark:border-t-gray-700";
    const tdName = document.createElement("td"); tdName.className = "h-[72px] px-4 py-2 w-[40%] text-base"; tdName.textContent = s.name + (me && s.playerId === me ? " (You)" : "");
    const tdHand = document.createElement("td"); tdHand.className = "h-[72px] px-4 py-2 w-[30%] text-right text-[#617589] dark:text-gray-400"; tdHand.textContent = `+${s.hand}`;
    const tdTotal = document.createElement("td"); tdTotal.className = "h-[72px] px-4 py-2 w-[30%] text-right"; tdTotal.textContent = String(s.total);
    tr.appendChild(tdName); tr.appendChild(tdHand); tr.appendChild(tdTotal);
    elHrTbody.appendChild(tr);
  });
}

function renderMatchSummary(): void {
  if (!elMsTbody) return;
  elMsTbody.innerHTML = "";
  const totals = state.players.map(p => ({ name: p.name, total: p.totalScore }));
  const sorted = totals.slice().sort((a, b) => b.total - a.total);
  sorted.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.className = "border-b border-b-gray-300/50";
    const tdName = document.createElement("td"); tdName.className = "h-[72px] px-4 py-3 text-lg"; tdName.textContent = s.name;
    const tdTotal = document.createElement("td"); tdTotal.className = "h-[72px] px-4 py-3 text-lg font-bold leading-normal text-right"; tdTotal.textContent = String(s.total);
    const tdStatus = document.createElement("td"); tdStatus.className = "h-[72px] px-4 py-3 w-28 sm:w-32 text-right";
    if (i === 0) { const wrap = document.createElement("div"); wrap.className = "flex items-center justify-end gap-2 text-yellow-500 text-lg font-bold"; const icon = document.createElement("span"); icon.className = "material-symbols-outlined text-2xl"; icon.textContent = "workspace_premium"; const lab = document.createElement("span"); lab.textContent = "Winner"; wrap.appendChild(icon); wrap.appendChild(lab); tdStatus.appendChild(wrap); }
    tr.appendChild(tdName); tr.appendChild(tdTotal); tr.appendChild(tdStatus);
    elMsTbody.appendChild(tr);
  });
}

function reshuffleIfNeeded(): void {
  if (state.drawPile.size() === 0 && state.discardPile.length > 1) {
    const top = state.discardPile.pop() as Card;
    const newDeck = new Deck(state.discardPile);
    newDeck.shuffle();
    state.drawPile = newDeck;
    state.discardPile = [top];
  }
}

function nextPlayer(): void {
  state.current = (state.current + 1) % state.players.length;
  state.players[state.current].hasDrawn = false;
  state.players[state.current].didDiscard = false;
  state.selectedIndices = [];
}

elBtnDraw.onclick = () => {
  const cur = state.players[state.current];
  if (cur.hasDrawn) return;
  if (state.netMode && state.net) {
    state.net.draw("pile");
    return;
  }
  reshuffleIfNeeded();
  const c = state.drawPile.draw();
  if (!c) return;
  cur.hand.push(c);
  cur.hasDrawn = true;
  render();
};

elBtnDrawDiscard.onclick = () => {
  const cur = state.players[state.current];
  if (cur.hasDrawn) return;
  if (state.netMode && state.net) {
    state.net.draw("discard");
    return;
  }
  const c = state.discardPile.pop();
  if (!c) return;
  cur.hand.push(c);
  cur.hasDrawn = true;
  render();
};

elBtnDiscard.onclick = () => {
  const cur = state.players[state.current];
  if (!cur.hasDrawn) return;
  if (state.selectedIndices.length !== 1) return;
  const selIdx = state.selectedIndices[0];
  const cand = cardImageCandidates(cur.hand[selIdx]);
  const cardImg = cand[0] || "";
  if (cardImg) animateCardToDiscard(selIdx, cardImg);
  if (state.netMode && state.net) {
    state.net.discard(state.selectedIndices[0]);
    state.selectedIndices = [];
    pulse(elBtnDiscard);
    return;
  }
  const [card] = cur.hand.splice(state.selectedIndices[0], 1);
  state.discardPile.push(card);
  cur.didDiscard = true;
  state.selectedIndices = [];
  render();
  pulse(elBtnDiscard);
  checkGoOutAfterDiscard();
};

elBtnEnd.onclick = () => {
  const cur = state.players[state.current];
  if (!cur.hasDrawn || !cur.didDiscard) return;
  if (state.netMode && state.net) {
    state.net.endTurn();
    return;
  }
  nextPlayer();
  render();
  pulse(elBtnLayGroup);
};

elBtnGive.onclick = () => {
  if (state.discardPile.length === 0) return;
  const cur = state.players[state.current];
  if (state.netMode && state.net) {
    const targetServerId = String(elSelTarget.value);
    if (!targetServerId || (cur.serverId && targetServerId === cur.serverId)) return;
    state.net.giveDiscardTo(targetServerId);
    return;
  }
  const targetId = Number(elSelTarget.value);
  const target = state.players.find(p => p.id === targetId);
  if (!target || target.id === cur.id) return;
  const top = state.discardPile.pop() as Card;
  target.hand.push(top);
  reshuffleIfNeeded();
  const bonus = state.drawPile.draw();
  if (bonus) target.hand.push(bonus);
  reshuffleIfNeeded();
  const draw = state.drawPile.draw();
  if (draw) cur.hand.push(draw);
  cur.hasDrawn = true;
  render();
  pulse(elBtnLayRun);
};

elBtnLayGroup.onclick = () => {
  const cur = state.players[state.current];
  if (state.selectedIndices.length < 3) return;
  const cards = state.selectedIndices.map(i => cur.hand[i]);
  if (state.netMode && state.net) {
    state.net.layGroup(state.selectedIndices.slice());
    state.selectedIndices = [];
    return;
  }
  if (!isValidGroup(cards)) return;
  cur.laidGroups.push(cards);
  const keep: Card[] = [];
  cur.hand.forEach((c, i) => { if (!state.selectedIndices.includes(i)) keep.push(c); });
  cur.hand = keep;
  state.selectedIndices = [];
  const reqs: PhaseRequirement[] = getPhaseRequirementsForHand(state.handNumber);
  let groupsReq = 0, runsReq = 0;
  reqs.forEach((r: PhaseRequirement) => { if (r.type === "group") groupsReq += r.count; else runsReq += r.count; });
  cur.laidComplete = cur.laidGroups.length >= groupsReq && cur.laidRuns.length >= runsReq;
  render();
  pulse(elBtnHit);
};

elBtnLayRun.onclick = () => {
  const cur = state.players[state.current];
  if (state.selectedIndices.length < 4) return;
  const cards = state.selectedIndices.map(i => cur.hand[i]);
  if (state.netMode && state.net) {
    state.net.layRun(state.selectedIndices.slice());
    state.selectedIndices = [];
    return;
  }
  if (!isValidRun(cards)) return;
  cur.laidRuns.push(cards);
  const keep: Card[] = [];
  cur.hand.forEach((c, i) => { if (!state.selectedIndices.includes(i)) keep.push(c); });
  cur.hand = keep;
  state.selectedIndices = [];
  const reqs: PhaseRequirement[] = getPhaseRequirementsForHand(state.handNumber);
  let groupsReq = 0, runsReq = 0;
  reqs.forEach((r: PhaseRequirement) => { if (r.type === "group") groupsReq += r.count; else runsReq += r.count; });
  cur.laidComplete = cur.laidGroups.length >= groupsReq && cur.laidRuns.length >= runsReq;
  render();
};

elBtnReset.onclick = () => {
  state.selectedIndices = [];
  render();
};

render();
function endHand(): void {
  const scores: { name: string; hand: number; total: number }[] = [];
  for (const p of state.players) {
    const handScore = scoreHand(p.hand);
    p.totalScore += handScore;
    scores.push({ name: p.name, hand: handScore, total: p.totalScore });
  }
  elScores.innerHTML = scores.map(s => `${s.name}: Hand ${s.hand} | Total ${s.total}`).join("<br>");
  elScoreboard.style.display = "block";
}

elBtnHit.onclick = () => {
  const cur = state.players[state.current];
  if (!cur.laidComplete) return;
  if (state.netMode && state.net) {
    const tServerId = String(elHitPlayer.value);
    const idx = Number(elHitIndex.value);
    const type = elHitType.value === "group" ? "group" : "run";
    state.net.hit(tServerId, type, idx, state.selectedIndices.slice());
    state.selectedIndices = [];
    return;
  }
  const targetId = Number(elHitPlayer.value);
  const target = state.players.find(p => p.id === targetId);
  if (!target) return;
  const idx = Number(elHitIndex.value);
  if (elHitType.value === "group") {
    const base = target.laidGroups[idx];
    if (!base) return;
    const add = state.selectedIndices.map(i => cur.hand[i]);
    const next = base.concat(add);
    if (!isValidGroup(next)) return;
    target.laidGroups[idx] = next;
  } else {
    const base = target.laidRuns[idx];
    if (!base) return;
    const add = state.selectedIndices.map(i => cur.hand[i]);
    const next = base.concat(add);
    if (!isValidRun(next)) return;
    target.laidRuns[idx] = next;
  }
  const keep: Card[] = [];
  cur.hand.forEach((c, i) => { if (!state.selectedIndices.includes(i)) keep.push(c); });
  cur.hand = keep;
  state.selectedIndices = [];
  render();
};

elBtnNextHand.onclick = () => {
  if (state.handNumber >= 6) {
    state.matchComplete = true;
    render();
    return;
  }
  state.handNumber += 1;
  const deck = new Deck(createDoubleDeck(true));
  deck.shuffle();
  state.drawPile = deck;
  state.discardPile = [];
  state.selectedIndices = [];
  for (const p of state.players) {
    p.hand = [];
    p.hasDrawn = false;
    p.didDiscard = false;
    p.laidGroups = [];
    p.laidRuns = [];
    p.laidComplete = false;
  }
  const deal = getDealCountForHand(state.handNumber);
  for (const p of state.players) {
    for (let j = 0; j < deal; j++) {
      const c = state.drawPile.draw();
      if (!c) break;
      p.hand.push(c);
    }
  }
  const first = state.drawPile.draw();
  if (first) state.discardPile.push(first);
  elScoreboard.style.display = "none";
  render();
};

function checkGoOutAfterDiscard(): void {
  const cur = state.players[state.current];
  if (cur.hand.length === 0) {
    endHand();
  }
}
function attachNet(): void {
  const net = new NetClient();
  net.connect();
  net.onState = (s: ServerRoomState) => {
    state.netMode = true;
    state.net = net;
    const nextStage = s.handComplete ? "hand_results" : (s.started ? "game" : "lobby");
    if (state.stage !== nextStage) state.prevStage = state.stage;
    state.stage = nextStage;
    state.handNumber = s.handNumber;
    state.current = s.currentIndex;
    state.drawPile = new Deck(s.drawPile.slice());
    state.discardPile = s.discardPile.slice();
    state.lastScores = s.lastScores || [];
    state.matchComplete = s.handComplete || false;
    state.turnDeadline = s.turnDeadline ?? null;
    (state as any).matchDeadline = s.matchDeadline ?? null;
    (state as any).spectators = s.spectators || [];
    state.lobbyDeadline = s.lobbyDeadline ?? null;
    if (state.stage === "lobby") startLobbyCountdown();
    // Map server players to local indices
    state.players = s.players.map((sp, i) => ({
      id: i,
      serverId: sp.id,
      name: sp.name,
      hand: sp.hand.slice(),
      hasDrawn: sp.hasDrawn,
      didDiscard: sp.didDiscard,
      laidGroups: [],
      laidRuns: [],
      laidComplete: false,
      totalScore: sp.totalScore,
    }));
    if (elLobbyRoomId) elLobbyRoomId.textContent = `Room: ${s.id}`;
    const myId = (state.net as NetClient).playerId;
    const p1 = s.players[0] || null;
    const p2 = s.players[1] || null;
    if (elSlot1Status) elSlot1Status.textContent = p1 ? (p1.name + (myId && p1.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot2Status) elSlot2Status.textContent = p2 ? (p2.name + (myId && p2.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elBtnSlot1Take) elBtnSlot1Take.disabled = !!p1 || !!myId;
    if (elBtnSlot2Take) elBtnSlot2Take.disabled = !!p2 || !!myId;
    if (elBtnSlot1Leave) elBtnSlot1Leave.disabled = !(p1 && myId && p1.id === myId);
    if (elBtnSlot2Leave) elBtnSlot2Leave.disabled = !(p2 && myId && p2.id === myId);
    if (elSlot1Ready) elSlot1Ready.textContent = p1 ? (p1.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot2Ready) elSlot2Ready.textContent = p2 ? (p2.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot1Ready) (elSlot1Ready as any).dataset.ready = String(!!(p1 && p1.ready));
    if (elSlot2Ready) (elSlot2Ready as any).dataset.ready = String(!!(p2 && p2.ready));
    const myReady = myId ? (s.players.find(x => x.id === myId)?.ready || false) : false;
    if (elBtnSlot1Ready) {
      const mine1 = !!(p1 && myId && p1.id === myId);
      const slot1Empty = !p1;
      elBtnSlot1Ready.disabled = !(mine1 || slot1Empty);
      elBtnSlot1Ready.textContent = mine1 ? (myReady ? "Unready" : "Ready") : "Ready";
      (elBtnSlot1Ready as any).dataset.ready = String(mine1 ? myReady : false);
    }
    if (elBtnSlot2Ready) {
      const mine2 = !!(p2 && myId && p2.id === myId);
      const slot2Empty = !p2;
      elBtnSlot2Ready.disabled = !(mine2 || slot2Empty);
      elBtnSlot2Ready.textContent = mine2 ? (myReady ? "Unready" : "Ready") : "Ready";
      (elBtnSlot2Ready as any).dataset.ready = String(mine2 ? myReady : false);
    }
    const bothReady = s.players.length === 2 && s.players.every(x => x.ready);
    if (elLobbyReadyChip) {
      const rc = s.players.filter(x => x.ready).length;
      elLobbyReadyChip.textContent = `${rc}/2 ready`;
    }
    if (elBtnLobbyStart) {
      const isPlayer = !!myId && s.players.some(x => x.id === myId);
      elBtnLobbyStart.disabled = !bothReady || s.started || !isPlayer;
    }
    if (elLobbyStatus) {
      const myIdx = myId ? s.players.findIndex(x => x.id === myId) : -1;
      if (myIdx >= 0) {
        const nm = s.players[myIdx].name;
        elLobbyStatus.textContent = `Seated at Player ${myIdx + 1} — ${nm}`;
      } else {
        elLobbyStatus.textContent = `Spectating`;
      }
    }
    if (elChatLog && !elChatLog.hasChildNodes()) {
      try {
        const rid = (state.net as NetClient)?.roomId || s.id;
        const raw = localStorage.getItem("chat:" + rid);
        if (raw) {
          const items = JSON.parse(raw) as { name: string; message: string; ts: number }[];
          for (const m of items) {
            const t = new Date(m.ts).toLocaleTimeString();
            const row = document.createElement("div");
            row.textContent = `[${t}] ${m.name}: ${m.message}`;
            elChatLog.appendChild(row);
          }
          elChatLog.scrollTop = elChatLog.scrollHeight;
          if (elLobbyChatLog && !elLobbyChatLog.hasChildNodes()) {
            for (const m of items) {
              const t = new Date(m.ts).toLocaleTimeString();
              const row2 = document.createElement("div");
              row2.textContent = `[${t}] ${m.name}: ${m.message}`;
              elLobbyChatLog.appendChild(row2);
            }
            elLobbyChatLog.scrollTop = elLobbyChatLog.scrollHeight;
          }
        }
      } catch {}
    }
    render();
  };
  net.onLobbyTimeout = () => {
    if (state.stage !== "lobby") return;
    try { localStorage.removeItem("roomId"); localStorage.removeItem("playerId"); } catch {}
    const back = state.prevStage || "title";
    state.stage = back;
    render();
  };
  net.onSpectatorJoin = (d) => {
    showToast(`${d.name} is spectating`);
  };
  if (elBtnLobbyExtend) {
    elBtnLobbyExtend.onclick = () => {
      const myId = net.playerId;
      const isPlayer = !!myId && (state as any).players ? (state as any).players.some((x: any) => x.serverId === myId) : true;
      if (!isPlayer) return;
      net.extendLobby(30, (ok, deadline) => {
        if (ok) {
          if (typeof deadline === "number") {
            state.lobbyDeadline = deadline;
            const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            const m = Math.floor(remain / 60);
            const s = remain % 60;
            if (elLobbyTimer) elLobbyTimer.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
            startLobbyCountdown();
          }
          showToast("Lobby extended +30s");
        }
      });
    };
  }
  net.onEvent = (e) => {
    const row = document.createElement("div");
    const t = new Date(e.ts).toLocaleTimeString();
    row.textContent = `[${t}] ${e.text}`;
    elEventLog.appendChild(row);
    elEventLog.scrollTop = elEventLog.scrollHeight;
  };
  net.onChat = (m) => {
    try {
      const rid = (state.net as NetClient)?.roomId || "";
      if (rid) {
        let arr: { name: string; message: string; ts: number }[] = [];
        try { arr = JSON.parse(localStorage.getItem("chat:" + rid) || "[]"); } catch {}
        arr.push(m);
        if (arr.length > 200) arr = arr.slice(arr.length - 200);
        try { localStorage.setItem("chat:" + rid, JSON.stringify(arr)); } catch {}
      }
    } catch {}
    const row = document.createElement("div");
    const t = new Date(m.ts).toLocaleTimeString();
    row.textContent = `[${t}] ${m.name}: ${m.message}`;
    row.className = "msg-highlight";
    elChatLog.appendChild(row);
    elChatLog.scrollTop = elChatLog.scrollHeight;
    const myName = elMpName.value || "";
    const fromOther = m.name !== myName;
    if (!state.chatOpen) {
      state.chatUnread += 1;
      if (elChatUnread) { elChatUnread.textContent = String(state.chatUnread); elChatUnread.classList.remove("hidden"); }
      if (state.stage === "game" && fromOther) {
        elChatPanel.classList.add("panel-open");
        elBtnToggleChat?.setAttribute("aria-expanded", "true");
        state.chatOpen = true;
        setTimeout(() => { elChatInput?.focus(); }, 10);
      }
    }
    if (elLobbyChatLog) {
      const row2 = document.createElement("div");
      row2.textContent = `[${t}] ${m.name}: ${m.message}`;
      elLobbyChatLog.appendChild(row2);
      elLobbyChatLog.scrollTop = elLobbyChatLog.scrollHeight;
    }
  };
  state.net = net;
}

function updateTimers(): void {
  if (!state.netMode) return;
  const dd = (state as any).matchDeadline || state.turnDeadline || null;
  if (dd) {
    const totalSec = Math.max(0, Math.ceil((dd - Date.now()) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (elTimerHours) elTimerHours.textContent = String(h).padStart(2, "0");
    if (elTimerMinutes) elTimerMinutes.textContent = String(m).padStart(2, "0");
    if (elTimerSeconds) elTimerSeconds.textContent = String(s).padStart(2, "0");
  } else {
    if (elTimerHours) elTimerHours.textContent = "00";
    if (elTimerMinutes) elTimerMinutes.textContent = "00";
    if (elTimerSeconds) elTimerSeconds.textContent = "00";
  }
  if (state.netMode) {
    const sNet = state.net as NetClient;
    let timerText = "";
    if (state.turnDeadline) {
      const sec = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
      timerText = ` • Turn: ${sec}s`;
    }
    if ((state as any).matchDeadline) {
      const sec2 = Math.max(0, Math.ceil(((state as any).matchDeadline - Date.now()) / 1000));
      const m2 = Math.floor(sec2 / 60);
      const s2 = sec2 % 60;
      timerText += ` • Match: ${String(m2).padStart(2, "0")}:${String(s2).padStart(2, "0")}`;
    }
    elMpInfo.textContent = `Room: ${sNet.roomId}${timerText}`;
  }
}

attachNet();
state.net?.resumeFromStorage();
loadSettings();
setInterval(() => { updateTimers(); }, 1000);

elBtnTitlePlay.onclick = () => { state.stage = "profile"; render(); };
elBtnTitleSettings.onclick = () => { state.stage = "settings"; render(); };
elBtnTitleHelp.onclick = () => { state.stage = "help"; render(); };
elBtnNameContinue.onclick = () => {
  const name = (elNameEntry.value || "Player").trim();
  elMpName.value = name;
  try { localStorage.setItem("playerName", name); } catch {}
  state.stage = "find";
  render();
};

elMpCreate.onclick = () => {
  const name = elMpName.value || "Player";
  state.net?.createRoom(name, (roomId) => { elMpRoom.value = roomId; state.stage = "lobby"; render(); startLobbyCountdown(); });
};

elMpJoin.onclick = () => {
  const name = elMpName.value || "Player";
  const room = elMpRoom.value.trim();
  if (!room) return;
  state.net?.joinRoom(room, name, (ok) => { elMpInfo.textContent = ok ? "Joined" : "Failed"; if (ok) { state.stage = "lobby"; render(); startLobbyCountdown(); } });
};

elMpSpectate.onclick = () => {
  const room = elMpRoom.value.trim();
  if (!room) return;
  const name = elMpName.value || "Spectator";
  state.net?.spectate(room, name, (ok) => { elMpInfo.textContent = ok ? "Spectating" : "Failed"; if (ok) state.stage = "game"; render(); });
};

elMpStart.onclick = () => {
  state.net?.startMatch();
};
elBtnNextHand.onclick = () => {
  if (state.netMode && state.net) {
    state.net.nextHand((ok, err) => {
      if (!ok && err === "match_complete") {
        try {
          const rid = (state.net as NetClient)?.roomId || "";
          if (rid) localStorage.removeItem("chat:" + rid);
        } catch {}
        state.stage = "match_summary";
        render();
      }
    });
    return;
  }
};

elMpSetTimer.onclick = () => {
  const sec = Number(elMpTimer.value || "0");
  if (!Number.isFinite(sec) || sec <= 0) return;
  state.net?.setTimer(Math.floor(sec * 1000));
};

elMpCopy.onclick = async () => {
  const room = (state.net as NetClient)?.roomId || "";
  try { await navigator.clipboard.writeText(room); elMpInfo.textContent = room ? "Copied" : ""; } catch {}
};
elMpLeave.onclick = () => { state.net?.leaveSeat(); };
elMpTake.onclick = () => {
  const name = elMpName.value || "Player";
  state.net?.takeSeat(name, (ok) => { elMpInfo.textContent = ok ? "Seated" : "Failed"; });
};
elMpResume.onclick = () => {
  const room = elMpRoom.value.trim();
  const pid = elMpPlayer.value.trim();
  if (!room || !pid) return;
  state.net?.resumeById(room, pid, (ok) => { elMpInfo.textContent = ok ? "Resumed" : "Failed"; });
};
elMpSwitch.onclick = () => {
  const idx1 = Number(elMpSeat.value || "0");
  if (!Number.isFinite(idx1) || idx1 <= 0) return;
  state.net?.switchSeat(Math.floor(idx1 - 1));
};

function renderMatchOptions(items: { id: string; handNumber: number; started: boolean; handComplete: boolean; players: { name: string; totalScore: number }[]; spectators: number }[]) {
  elSelMatch.innerHTML = "";
  const filtered = items.filter(r => {
    if (state.filter === "lobby") return !r.started;
    if (state.filter === "active") return r.started && !r.handComplete;
    if (state.filter === "complete") return r.handComplete;
    return true;
  });
  filtered.forEach(r => {
    const opt = document.createElement("option");
    const players = r.players.map(p => `${p.name}(${p.totalScore})`).join(" vs ");
    const status = r.handComplete ? "Complete" : r.started ? `Hand ${r.handNumber}` : "Lobby";
    opt.value = r.id;
    opt.textContent = `${r.id} • ${status} • ${players} • Specs:${r.spectators}`;
    elSelMatch.appendChild(opt);
  });
}

elBtnFindRefresh && (elBtnFindRefresh.onclick = () => {
  state.net?.listRooms((rooms) => { state.rooms = rooms; renderFindList(rooms); });
});

elBtnBrowse.onclick = () => { state.stage = "find"; render(); };

elBtnWatch.onclick = () => {
  const room = elSelMatch.value || "";
  if (!room) return;
  const name = elMpName.value || "Spectator";
  state.net?.spectate(room, name, (ok) => { elMpInfo.textContent = ok ? "Spectating" : "Failed"; if (ok) state.stage = "game"; render(); });
};
elBtnPlay.onclick = () => {
  const room = elSelMatch.value || "";
  if (!room) return;
  const summary = state.rooms.find(r => r.id === room);
  if (!summary) return;
  const canPlay = !summary.started && summary.players.length === 1;
  if (!canPlay) { elMpInfo.textContent = "Room busy"; return; }
  const name = elMpName.value || "Player";
  state.net?.joinRoom(room, name, (ok) => { elMpInfo.textContent = ok ? "Joined" : "Failed"; if (ok) { state.stage = "game"; render(); } });
};
elChatSend.onclick = () => { const msg = elChatInput.value.trim(); if (!msg) return; state.net?.chat(msg); elChatInput.value = ""; };
elSelFilter.onchange = () => {
  state.filter = (elSelFilter.value as any) || "all";
  renderMatchOptions(state.rooms);
};

if (elHitPlayer) elHitPlayer.onchange = () => { render(); };
if (elHitType) elHitType.onchange = () => { render(); };

let autoTimer: number | null = null;
function ensureAutoRefresh(on: boolean) {
  if (on) {
    if (autoTimer == null) autoTimer = window.setInterval(() => { if (state.stage === "lobby") elBtnRefresh.click(); }, 5000);
  } else {
    if (autoTimer != null) { window.clearInterval(autoTimer); autoTimer = null; }
  }
}
elChkAuto.onchange = () => { ensureAutoRefresh(elChkAuto.checked); };

elMpTakeAt.onclick = () => {
  const idx1 = Number(elMpSeat.value || "1");
  if (!Number.isFinite(idx1) || idx1 <= 0) return;
  const name = elMpName.value || "Player";
  state.net?.takeSeatAt(name, Math.floor(idx1 - 1), (ok) => { elMpInfo.textContent = ok ? "Seated" : "Failed"; });
};
function renderFindList(items: { id: string; handNumber: number; started: boolean; handComplete: boolean; players: { name: string; totalScore: number }[]; spectators: number }[]) {
  if (!elFindList) return;
  elFindList.innerHTML = "";
  items.forEach(r => {
    const card = document.createElement("div");
    card.className = "rounded-xl border p-6 bg-white dark:bg-gray-800";
    const title = document.createElement("div");
    const status = r.handComplete ? "Complete" : r.started ? `Hand ${r.handNumber}` : "Lobby";
    title.textContent = `Room ${r.id} — ${status}`;
    const players = document.createElement("div");
    players.textContent = r.players.map(p => `${p.name}(${p.totalScore})`).join(" vs ");
    const actions = document.createElement("div");
    actions.className = "flex gap-3 pt-3";
    const play = document.createElement("button");
    play.textContent = "Play";
    play.className = "h-12 px-5 rounded-lg bg-primary text-white font-bold";
    play.onclick = () => {
      const name = elMpName.value || "Player";
      state.net?.joinRoom(r.id, name, (ok) => { elMpInfo.textContent = ok ? "Joined" : "Failed"; if (ok) { elMpRoom.value = r.id; state.stage = "lobby"; render(); } });
    };
    const watch = document.createElement("button");
    watch.textContent = "Watch";
    watch.className = "h-12 px-5 rounded-lg bg-black/5 dark:bg-white/5 font-bold";
    watch.onclick = () => {
      const name = elMpName.value || "Spectator";
      state.net?.spectate(r.id, name, (ok) => { elMpInfo.textContent = ok ? "Spectating" : "Failed"; if (ok) { elMpRoom.value = r.id; state.stage = "game"; render(); } });
    };
    actions.appendChild(play);
    actions.appendChild(watch);
    card.appendChild(title);
    card.appendChild(players);
    card.appendChild(actions);
    elFindList.appendChild(card);
  });
}
if (elBtnFindCreate) {
  elBtnFindCreate.onclick = () => {
    const name = (elMpName.value || "Player").trim();
    const minutesSel = document.getElementById("find-match-limit") as HTMLSelectElement;
    const minutesRaw = minutesSel ? minutesSel.value : "30";
    const minutes = Number(minutesRaw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      if (elMpInfo) elMpInfo.textContent = "Pick a match limit";
      return;
    }
    if (!state.net) attachNet();
    if (!state.net?.socket) state.net?.connect();
    if (elMpInfo) elMpInfo.textContent = "Creating...";
    state.net?.createRoom(name, minutes, (roomId) => {
      elMpRoom.value = roomId;
      state.stage = "lobby";
      render();
      startLobbyCountdown();
      if (elMpInfo) elMpInfo.textContent = roomId ? "Room created" : "";
      if (elBtnSlot1Ready) { elBtnSlot1Ready.disabled = false; (elBtnSlot1Ready as any).dataset.ready = "false"; elBtnSlot1Ready.textContent = "Ready"; }
      if (elSlot1Ready) { elSlot1Ready.textContent = "Not Ready"; (elSlot1Ready as any).dataset.ready = "false"; }
      if (elLobbyReadyChip) elLobbyReadyChip.textContent = "0/2 ready";
    });
  };
}
if (elBtnFindJoin) {
  elBtnFindJoin.onclick = () => {
    const name = elMpName.value || "Player";
    const room = (elFindRoomId.value || elMpRoom.value).trim();
    if (!room) return;
    state.net?.joinRoom(room, name, (ok) => {
      elMpInfo.textContent = ok ? "Joined" : "Failed";
      if (ok) {
        state.stage = "lobby";
        render();
        startLobbyCountdown();
        if (elBtnSlot2Ready) { elBtnSlot2Ready.disabled = false; (elBtnSlot2Ready as any).dataset.ready = "false"; elBtnSlot2Ready.textContent = "Ready"; }
        if (elSlot2Ready) { elSlot2Ready.textContent = "Not Ready"; (elSlot2Ready as any).dataset.ready = "false"; }
        const r1 = (elSlot1Ready as any)?.dataset?.ready === "true" ? 1 : 0;
        const r2 = (elSlot2Ready as any)?.dataset?.ready === "true" ? 1 : 0;
        if (elLobbyReadyChip) elLobbyReadyChip.textContent = `${r1 + r2}/2 ready`;
      }
    });
  };
}
if (elBtnFindRefresh) {
  elBtnFindRefresh.onclick = () => {
    state.net?.listRooms((rooms) => { state.rooms = rooms; renderFindList(rooms); });
    state.net?.listRecent((items) => { renderRecentList(items); });
  };
}
if (elBtnCopyRoom) {
  elBtnCopyRoom.onclick = async () => { const r = (state.net as NetClient)?.roomId || ""; try { await navigator.clipboard.writeText(r); } catch {} };
}
if (elBtnSlot1Take) { elBtnSlot1Take.onclick = () => { const name = elMpName.value || "Player"; state.net?.takeSeatAt(name, 0, (ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Seated at 1" : "Failed"; if (ok && elBtnSlot1Ready) { elBtnSlot1Ready.disabled = false; elBtnSlot1Ready.textContent = "Ready"; (elBtnSlot1Ready as any).dataset.ready = "false"; } }); }; }
if (elBtnSlot2Take) { elBtnSlot2Take.onclick = () => { const name = elMpName.value || "Player"; state.net?.takeSeatAt(name, 1, (ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Seated at 2" : "Failed"; if (ok && elBtnSlot2Ready) { elBtnSlot2Ready.disabled = false; elBtnSlot2Ready.textContent = "Ready"; (elBtnSlot2Ready as any).dataset.ready = "false"; } }); }; }
if (elBtnSlot1Leave) { elBtnSlot1Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot1Take) elBtnSlot1Take.disabled = false; if (elBtnSlot1Ready) { elBtnSlot1Ready.disabled = true; elBtnSlot1Ready.textContent = "Ready"; (elBtnSlot1Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot2Leave) { elBtnSlot2Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot2Take) elBtnSlot2Take.disabled = false; if (elBtnSlot2Ready) { elBtnSlot2Ready.disabled = true; elBtnSlot2Ready.textContent = "Ready"; (elBtnSlot2Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot1Ready) {
  elBtnSlot1Ready.onclick = () => {
    const cur = (elSlot1Ready as any)?.dataset?.ready === "true";
    const next = !cur;
    const name = elMpName.value || "Player";
    if (!state.net?.playerId) {
      state.net?.takeSeatAt(name, 0, (ok) => {
        if (!ok) { if (elLobbyStatus) elLobbyStatus.textContent = "Seat 1 occupied"; return; }
        state.net?.setSeatReady(0, next, (ok2) => { if (!ok2 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 1"; });
      });
      return;
    }
    state.net?.setSeatReady(0, next, (ok3) => { if (!ok3 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 1"; });
  };
}
if (elBtnSlot2Ready) {
  elBtnSlot2Ready.onclick = () => {
    const cur = (elSlot2Ready as any)?.dataset?.ready === "true";
    const next = !cur;
    const name = elMpName.value || "Player";
    if (!state.net?.playerId) {
      state.net?.takeSeatAt(name, 1, (ok) => {
        if (!ok) { if (elLobbyStatus) elLobbyStatus.textContent = "Seat 2 occupied"; return; }
        state.net?.setSeatReady(1, next, (ok2) => { if (!ok2 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 2"; });
      });
      return;
    }
    state.net?.setSeatReady(1, next, (ok3) => { if (!ok3 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 2"; });
  };
}
if (elBtnLobbyStart) { elBtnLobbyStart.onclick = () => { state.net?.startMatch(); }; }
if (elLobbyChatSend) { elLobbyChatSend.onclick = () => { const msg = elLobbyChatInput.value.trim(); if (!msg) return; state.net?.chat(msg); elLobbyChatInput.value = ""; }; }

if (elLobbyChatInput && elLobbyChatSend) {
  elLobbyChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); elLobbyChatSend.click(); }
  });
}

// match limit is set on room creation from Find page

if (elBtnLobbyLeave) {
  elBtnLobbyLeave.onclick = () => {
    const wasPlayer = !!state.net?.playerId;
    const done = () => { state.stage = "find"; render(); };
    const onlyPlayer = state.stage === "lobby" && Array.isArray(state.players) && state.players.length <= 1;
    if (onlyPlayer) {
      state.net?.closeRoom((ok) => { state.net?.leaveRoom(() => done()); });
      return;
    }
    if (wasPlayer) {
      state.net?.leaveSeat(() => { state.net?.leaveRoom(() => done()); });
    } else {
      state.net?.leaveRoom(() => done());
    }
  };
}

if (elBtnSettingsBack) { elBtnSettingsBack.onclick = () => { state.stage = "title"; render(); }; }
if (elBtnHelpBack) { elBtnHelpBack.onclick = () => { state.stage = "title"; render(); }; }
if (elBtnSaveSettings) { elBtnSaveSettings.onclick = () => { state.stage = "title"; render(); }; }

if (elBtnSaveSettings) {
  elBtnSaveSettings.onclick = () => {
    const s: AppSettings = {
      theme: elOptTheme?.value === "light" ? "light" : "dark",
      textSize: elOptTextSize?.value === "lg" ? "lg" : "md",
      highContrast: !!elOptHighContrast?.checked,
    };
    try { localStorage.setItem("appSettings", JSON.stringify(s)); } catch {}
    applySettings(s);
    state.stage = "title";
    render();
  };
}
if (elBtnPlayAgain) { elBtnPlayAgain.onclick = () => { state.stage = "find"; render(); }; }
if (elBtnReturnMenu) { elBtnReturnMenu.onclick = () => { state.stage = "title"; render(); }; }
if (elBtnHandBack) { elBtnHandBack.onclick = () => { state.stage = "lobby"; render(); }; }

if (elBtnToggleChat && elChatPanel) {
  elBtnToggleChat.onclick = () => {
    const willOpen = elChatPanel.classList.contains("hidden") || !elChatPanel.classList.contains("panel-open");
    if (willOpen) {
      elChatPanel.classList.remove("hidden");
      elChatPanel.classList.add("panel-open");
    } else {
      elChatPanel.classList.remove("panel-open");
      elChatPanel.classList.add("hidden");
    }
    const nowOpen = willOpen;
    state.chatOpen = nowOpen;
    elBtnToggleChat.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    if (nowOpen) {
      state.chatUnread = 0;
      elChatUnread?.classList.add("hidden");
    }
    if (nowOpen) setTimeout(() => { elChatInput?.focus(); }, 10);
  };
}

if (elBtnMatchLeave) {
  elBtnMatchLeave.onclick = () => {
    const wasPlayer = !!state.net?.playerId;
    const done = () => { state.stage = "find"; render(); };
    if (wasPlayer) {
      state.net?.leaveSeat(() => { state.net?.leaveRoom(() => done()); });
    } else {
      state.net?.leaveRoom(() => done());
    }
  };
}
if (elBtnCloseChat && elChatPanel) {
  elBtnCloseChat.onclick = () => {
    elChatPanel.classList.remove("panel-open");
    elChatPanel.classList.add("hidden");
    elBtnToggleChat?.setAttribute("aria-expanded", "false");
    state.chatOpen = false;
  };
}
if (elChatInput && elChatSend) {
  elChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); elChatSend.click(); }
  });
}
function pulse(el: HTMLElement) {
  el.classList.add("pulse-success");
  setTimeout(() => el.classList.remove("pulse-success"), 260);
}

function animateCardToDiscard(idx: number, img: string) {
  if (!elHandGrid || !elDiscardTop) return;
  const srcEl = elHandGrid.children[idx] as HTMLElement;
  if (!srcEl) return;
  const srcRect = srcEl.getBoundingClientRect();
  const dstRect = (elDiscardTop as HTMLElement).getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.left = `${srcRect.left}px`;
  overlay.style.top = `${srcRect.top}px`;
  overlay.style.width = `${srcRect.width}px`;
  overlay.style.height = `${srcRect.height}px`;
  overlay.style.backgroundImage = `url('${cardBackPath()}')`;
  overlay.style.backgroundSize = "contain";
  overlay.style.backgroundPosition = "center";
  overlay.style.borderRadius = "12px";
  overlay.style.boxShadow = "0 12px 28px rgba(0,0,0,0.35)";
  overlay.style.zIndex = "9999";
  overlay.style.transition = "transform 320ms ease, opacity 320ms ease";
  overlay.style.transform = "translate(0,0) rotateY(0deg)";
  overlay.style.opacity = "1";
  document.body.appendChild(overlay);
  const dx = dstRect.left - srcRect.left;
  const dy = dstRect.top - srcRect.top;
  requestAnimationFrame(() => {
    overlay.style.transform = `translate(${dx}px, ${dy}px) scale(${dstRect.width / srcRect.width}) rotateY(180deg)`;
    overlay.style.opacity = "0.85";
  });
  setTimeout(() => { overlay.style.backgroundImage = `url('${img}')`; }, 160);
  setTimeout(() => { overlay.remove(); }, 360);
}
try { const saved = localStorage.getItem("playerName"); if (saved) { (document.getElementById("mp-name") as HTMLInputElement).value = saved; } } catch {}
function normalizeSettings(obj: any): AppSettings {
  const theme: "light" | "dark" = obj && obj.theme === "light" ? "light" : "dark";
  const textSize: "md" | "lg" = obj && obj.textSize === "lg" ? "lg" : "md";
  const highContrast: boolean = !!(obj && obj.highContrast);
  return { theme, textSize, highContrast };
}
if (elSlot1Ready) (elSlot1Ready as any).dataset.ready = "false";
if (elSlot2Ready) (elSlot2Ready as any).dataset.ready = "false";
function renderRecentList(items: { id: string; ended: number; reason: string; players: { name: string; totalScore: number }[] }[]): void {
  if (!elRecentList) return;
  elRecentList.innerHTML = "";
  items.forEach(r => {
    const card = document.createElement("div");
    card.className = "rounded-xl border p-6 bg-white dark:bg-gray-800";
    const title = document.createElement("div");
    const when = new Date(r.ended).toLocaleTimeString();
    title.textContent = `Room ${r.id} — ${r.reason} — ${when}`;
    const players = document.createElement("div");
    players.textContent = r.players.map(p => `${p.name}(${p.totalScore})`).join(" vs ");
    card.appendChild(title);
    card.appendChild(players);
    elRecentList.appendChild(card);
  });
}
