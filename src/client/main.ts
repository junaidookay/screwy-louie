import { createDoubleDeck, Card } from "../engine/card";
import { Deck } from "../engine/deck";
import { getDealCountForHand, getPhaseRequirementsForHand, PhaseRequirement } from "../engine/game";
import { NetClient, ServerRoomState, RoomSummary } from "./net";
import { scoreHand } from "../engine/scoring";
import { isValidGroup, isValidRun, whyRunInvalid } from "../engine/rules";

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
  if (c.rank === "Joker") return "Card Game Assets/Cards/Joker of Spades Card.png";
  if (!c.suit) return "";
  const rl = rankLabel(c.rank);
  return `Card Game Assets/Cards/${rl} of ${c.suit} Card.png`;
}

function cardImageCandidates(c: Card): string[] {
  if (c.rank === "Joker") return [
    "Card Game Assets/Cards/Joker of Spades Card.png",
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

function spinCard(el: HTMLElement): void {
  const prev = el.style.backgroundImage || "";
  const restore = () => { el.style.backgroundImage = prev; el.classList.remove("card-spin"); };
  el.classList.add("card-spin");
  const back = cardBackPath();
  el.style.backgroundImage = `url('${back}')`;
  el.style.backgroundSize = "contain";
  el.style.backgroundRepeat = "no-repeat";
  el.style.backgroundPosition = "center";
  setTimeout(restore, 600);
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
const elDrawBack = document.getElementById("draw-back") as HTMLElement;
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
const elTableArea = document.getElementById("table-area") as HTMLElement;
// timers removed from UI
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
const elSlot3Status = document.getElementById("slot3-status") as HTMLElement;
const elSlot4Status = document.getElementById("slot4-status") as HTMLElement;
const elSlot5Status = document.getElementById("slot5-status") as HTMLElement;
const elSlot6Status = document.getElementById("slot6-status") as HTMLElement;
const elSlot1You = document.getElementById("slot1-you") as HTMLElement;
const elSlot2You = document.getElementById("slot2-you") as HTMLElement;
const elSlot3You = document.getElementById("slot3-you") as HTMLElement;
const elSlot4You = document.getElementById("slot4-you") as HTMLElement;
const elSlot5You = document.getElementById("slot5-you") as HTMLElement;
const elSlot6You = document.getElementById("slot6-you") as HTMLElement;
const elBtnSlot1Take = document.getElementById("btn-slot1-take") as HTMLButtonElement;
const elBtnSlot1Leave = document.getElementById("btn-slot1-leave") as HTMLButtonElement;
const elBtnSlot2Take = document.getElementById("btn-slot2-take") as HTMLButtonElement;
const elBtnSlot2Leave = document.getElementById("btn-slot2-leave") as HTMLButtonElement;
const elBtnSlot3Take = document.getElementById("btn-slot3-take") as HTMLButtonElement;
const elBtnSlot3Leave = document.getElementById("btn-slot3-leave") as HTMLButtonElement;
const elBtnSlot5Take = document.getElementById("btn-slot5-take") as HTMLButtonElement;
const elBtnSlot5Leave = document.getElementById("btn-slot5-leave") as HTMLButtonElement;
const elBtnSlot6Take = document.getElementById("btn-slot6-take") as HTMLButtonElement;
const elBtnSlot6Leave = document.getElementById("btn-slot6-leave") as HTMLButtonElement;
const elBtnSlot4Take = document.getElementById("btn-slot4-take") as HTMLButtonElement;
const elBtnSlot4Leave = document.getElementById("btn-slot4-leave") as HTMLButtonElement;
const elSlot1Ready = document.getElementById("slot1-ready") as HTMLElement;
const elSlot2Ready = document.getElementById("slot2-ready") as HTMLElement;
const elSlot3Ready = document.getElementById("slot3-ready") as HTMLElement;
const elSlot4Ready = document.getElementById("slot4-ready") as HTMLElement;
const elSlot5Ready = document.getElementById("slot5-ready") as HTMLElement;
const elSlot6Ready = document.getElementById("slot6-ready") as HTMLElement;
const elBtnSlot1Ready = document.getElementById("btn-slot1-ready") as HTMLButtonElement;
const elBtnSlot2Ready = document.getElementById("btn-slot2-ready") as HTMLButtonElement;
const elBtnSlot3Ready = document.getElementById("btn-slot3-ready") as HTMLButtonElement;
const elBtnSlot4Ready = document.getElementById("btn-slot4-ready") as HTMLButtonElement;
const elBtnSlot5Ready = document.getElementById("btn-slot5-ready") as HTMLButtonElement;
const elBtnSlot6Ready = document.getElementById("btn-slot6-ready") as HTMLButtonElement;
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

let hoverPreviewEl: HTMLElement | null = null;
let hoverHideTimer: any = null;
function ensureHoverPreview(): HTMLElement {
  if (!hoverPreviewEl) {
    const el = document.createElement("div");
    el.id = "hover-preview";
    el.style.position = "fixed";
    el.style.width = "96px";
    el.style.aspectRatio = "3 / 4" as any;
    el.style.backgroundSize = "contain";
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundPosition = "center";
    el.style.borderRadius = "10px";
    el.style.boxShadow = "0 10px 24px rgba(0,0,0,0.30)";
    el.style.zIndex = "9999";
    el.style.pointerEvents = "none";
    el.style.opacity = "0";
    el.style.transition = "opacity 120ms ease, transform 120ms ease";
    document.body.appendChild(el);
    hoverPreviewEl = el;
  }
  return hoverPreviewEl;
}

function positionHoverPreview(x: number, y: number): void {
  const el = ensureHoverPreview();
  const pad = 16;
  const w = 96;
  const h = 128;
  const maxX = window.innerWidth - w - pad;
  const maxY = window.innerHeight - h - pad;
  const left = Math.max(pad, Math.min(x + 12, maxX));
  const top = Math.max(pad, Math.min(y + 12, maxY));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showHoverPreview(c: Card, x: number, y: number): void {
  const el = ensureHoverPreview();
  if (hoverHideTimer) { try { clearTimeout(hoverHideTimer); } catch {} hoverHideTimer = null; }
  setBackgroundCard(el, c);
  positionHoverPreview(x, y);
  el.style.opacity = "1";
  el.style.display = "block";
}

function moveHoverPreview(x: number, y: number): void {
  const el = ensureHoverPreview();
  positionHoverPreview(x, y);
}

function hideHoverPreview(): void {
  if (!hoverPreviewEl) return;
  hoverPreviewEl.style.opacity = "0";
  hoverHideTimer = setTimeout(() => { if (hoverPreviewEl) hoverPreviewEl.style.display = "none"; hoverHideTimer = null; }, 140);
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
  elPlayers.classList.toggle("hidden", state.stage !== "game");
  if (elMain) elMain.classList.add("hidden");
  elDrawSize.textContent = `${state.drawPile.size()} cards`;
  if (elDrawBack) {
    elDrawBack.innerHTML = "";
    elDrawBack.style.position = "relative";
    const layers = Math.min(4, Math.max(1, Math.ceil(state.drawPile.size() / 20)));
    for (let i = layers - 1; i > 0; i--) {
      const layer = document.createElement("div");
      layer.className = "absolute inset-0 rounded-lg shadow-sm bg-center bg-no-repeat bg-contain border border-gray-200 dark:border-gray-700";
      layer.style.transform = `translate(${i * 2}px, ${i * 2}px)`;
      layer.style.backgroundImage = `url('${cardBackPath()}')`;
      elDrawBack.appendChild(layer);
    }
    elDrawBack.style.backgroundImage = `url('${cardBackPath()}')`;
    elDrawBack.style.backgroundSize = "contain";
    elDrawBack.style.backgroundRepeat = "no-repeat";
    elDrawBack.style.backgroundPosition = "center";
    elDrawBack.title = `${state.drawPile.size()} cards`;
    elDrawBack.onclick = () => { if (!elBtnDraw.disabled) elBtnDraw.click(); };
  }
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
    container.className = "player flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 shadow-sm";
    const title = document.createElement("div");
    title.className = "player-header flex items-center gap-2";
    const left = document.createElement("div");
    left.className = "name-block";
    const headerLine = document.createElement("div"); headerLine.className = "header-line inline-flex items-center gap-2";
    const metaLine = document.createElement("div"); metaLine.className = "meta-line inline-flex items-center gap-2 flex-wrap";
    const laidInfo = `G${p.laidGroups.length} R${p.laidRuns.length} • Total ${p.totalScore}`;
    const sid = state.netMode && p.serverId ? ` (${p.serverId.slice(0, 6)})` : "";
    const nameSpan = document.createElement("span"); nameSpan.className = "font-semibold"; nameSpan.textContent = `${p.name}${sid}`;
    headerLine.appendChild(nameSpan);
    if (state.current === p.id) {
      const badge = document.createElement("span");
      badge.className = "ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 bg-primary text-white text-xs font-bold";
      badge.innerHTML = `<span class='material-symbols-outlined' style='font-size:14px'>play_arrow</span><span>Turn</span>`;
      headerLine.appendChild(badge);
      container.classList.add("my-turn");
    }
    const chip = document.createElement("span");
    chip.className = "stat-chip";
    chip.innerHTML = `
      <span class='material-symbols-outlined chip-icon'>groups</span><span>G${p.laidGroups.length}</span>
      <span class='chip-sep'>•</span>
      <span class='material-symbols-outlined chip-icon'>alt_route</span><span>R${p.laidRuns.length}</span>
      <span class='chip-sep'>•</span>
      <span class='material-symbols-outlined chip-icon'>scoreboard</span><span>Total ${p.totalScore}</span>
    `;
    metaLine.appendChild(chip);
    const right = document.createElement("div"); right.className = "player-cards text-sm inline-flex items-center gap-2";
    right.innerHTML = `<span class='material-symbols-outlined' style='font-size:16px'>style</span><span>Cards: ${p.hand.length}</span>`;
    metaLine.appendChild(right);
    left.appendChild(headerLine);
    left.appendChild(metaLine);
    title.appendChild(left);
    container.appendChild(title);
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
  if (elBtnDraw) elBtnDraw.disabled = isSpectator || !myTurn || my.hasDrawn;
  if (elBtnDrawDiscard) elBtnDrawDiscard.disabled = isSpectator || !myTurn || my.hasDrawn || state.discardPile.length === 0;
  if (elBtnDiscard) elBtnDiscard.disabled = false;
  if (elBtnEnd) elBtnEnd.disabled = false;
  const curName = state.players[state.current]?.name || "Player";
  const reqParts = getPhaseRequirementsForHand(state.handNumber).map(r => r.type === "group" ? `${r.count} Group${r.count>1?"s":""}` : `${r.count} Run${r.count>1?"s":""}`);
  elStatus.textContent = `Round ${state.handNumber}: ${reqParts.join(" + ")} • Turn: ${curName}`;
  if (elSelTarget) {
    elSelTarget.innerHTML = "";
    state.players.forEach(p => {
      const opt = document.createElement("option");
      opt.value = state.netMode ? String(p.serverId) : String(p.id);
      opt.textContent = p.name;
      elSelTarget.appendChild(opt);
    });
  }
  if (elBtnGive) elBtnGive.disabled = isSpectator || state.discardPile.length === 0;
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
  elBtnHit.disabled = false;
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
    elMpInfo.textContent = `Room: ${s.roomId}`;
    if ((state as any).spectators && Array.isArray((state as any).spectators)) {
      const specs = (state as any).spectators as { id: string; name: string }[];
      if (elSpectators) elSpectators.innerHTML = specs.length ? `Spectators: ${specs.map(x => x.name).join(", ")}` : "Spectators: None";
    }
  }

  const dd = (state as any).matchDeadline || state.turnDeadline || null;
  // timer digits removed

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
      outer.className = "flex flex-col gap-3" + (isSel ? " selected-frame transform -translate-y-4" : "");
      const inner = document.createElement("div");
      inner.className = "w-full bg-center bg-no-repeat aspect-[3/4] bg-cover rounded-lg shadow-md hover:shadow-2xl hover:-translate-y-2 transition-all" + (isSel ? " selected-card" : "");
      setBackgroundCard(inner, c);
      inner.title = formatCard(c);
      {
        let clickTimer: number | null = null;
        let lastTs = 0;
        inner.addEventListener("click", () => {
          const now = Date.now();
          if (now - lastTs <= 250) {
            lastTs = 0;
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            spinCard(inner);
            return;
          }
          lastTs = now;
          clickTimer = window.setTimeout(() => {
            if (state.current !== p.id) { clickTimer = null; return; }
            const pos = state.selectedIndices.indexOf(idx);
            if (pos >= 0) { state.selectedIndices.splice(pos, 1); hideHoverPreview(); } else { state.selectedIndices.push(idx); }
            render();
            clickTimer = null;
          }, 250);
        });
      }
      inner.addEventListener("mouseenter", (e) => { showHoverPreview(c, (e as MouseEvent).pageX, (e as MouseEvent).pageY); });
      inner.addEventListener("mousemove", (e) => { moveHoverPreview((e as MouseEvent).pageX, (e as MouseEvent).pageY); });
      inner.addEventListener("mouseleave", () => { hideHoverPreview(); });
      inner.draggable = state.current === p.id;
      inner.addEventListener("dragstart", (e) => {
        hideHoverPreview();
        if (state.current !== p.id) return;
        try { e.dataTransfer?.setData("text/plain", String(idx)); } catch {}
        try { e.dataTransfer && (e.dataTransfer.effectAllowed = "move"); } catch {}
      });
      inner.addEventListener("dragover", (e) => { e.preventDefault(); });
      inner.addEventListener("drop", (e) => {
        e.preventDefault();
        if (state.current !== p.id) return;
        const fromRaw = e.dataTransfer?.getData("text/plain") || "";
        const fromIdx = Number(fromRaw);
        if (!Number.isFinite(fromIdx)) return;
        if (fromIdx === idx) return;
        const curHand = p.hand.slice();
        const [moved] = curHand.splice(fromIdx, 1);
        if (!moved) return;
        curHand.splice(idx, 0, moved);
        p.hand = curHand;
        if (state.netMode && state.net && p.serverId && (state.net as any).playerId === p.serverId) {
          state.net.reorderHand(fromIdx, idx);
        }
        render();
      });
      outer.appendChild(inner);
      elHandGrid.appendChild(outer);
    });
  }

  if (elTableArea) {
    elTableArea.innerHTML = "";
    const list = document.createElement("div");
    list.className = "w-full flex flex-col gap-4";
    let shown = false;
    state.players.forEach((p) => {
      const has = p.laidGroups.length > 0 || p.laidRuns.length > 0;
      if (!has) return;
      shown = true;
      const sec = document.createElement("div");
      sec.className = "w-full";
      const title = document.createElement("div"); title.className = "text-sm font-semibold mb-1"; title.textContent = `${p.name}'s Table`;
      sec.appendChild(title);
      const grid = document.createElement("div"); grid.className = "flex flex-col gap-2";
      p.laidGroups.forEach((g, gi) => {
        const row = document.createElement("div"); row.className = "flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/40 px-2 py-1 slide-in-row";
        const label = document.createElement("span"); label.className = "text-xs font-semibold text-gray-600 dark:text-gray-300 inline-flex items-center gap-1"; label.innerHTML = `<span class='material-symbols-outlined' style='font-size:14px'>groups</span><span>Group ${gi + 1}</span>`; row.appendChild(label);
        const cardsWrap = document.createElement("div"); cardsWrap.className = "flex items-center gap-2";
        g.forEach((c) => { const cardEl = document.createElement("div"); cardEl.className = "w-12 aspect-[3/4] rounded-md border bg-center bg-no-repeat bg-contain shadow-sm"; setBackgroundCard(cardEl, c); cardEl.title = formatCard(c); cardEl.addEventListener("mouseenter", (e) => { showHoverPreview(c, (e as MouseEvent).pageX, (e as MouseEvent).pageY); }); cardEl.addEventListener("mousemove", (e) => { moveHoverPreview((e as MouseEvent).pageX, (e as MouseEvent).pageY); }); cardEl.addEventListener("mouseleave", () => { hideHoverPreview(); }); cardsWrap.appendChild(cardEl); });
        row.appendChild(cardsWrap);
        // drag-to-hit
        row.addEventListener("dragover", (e) => { e.preventDefault(); });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          const cur = state.players[state.current];
          if (!cur.laidComplete) { showToast("Lay down first"); return; }
          const raw = e.dataTransfer?.getData("text/plain") || "";
          const idx = Number(raw);
          const addIdxs = state.selectedIndices.length ? state.selectedIndices.slice() : (Number.isFinite(idx) ? [idx] : []);
          if (!addIdxs.length) return;
          if (state.netMode && state.net && p.serverId) {
            state.net.hit(String(p.serverId), "group", gi, addIdxs);
            state.selectedIndices = [];
            return;
          }
          const base = p.laidGroups[gi];
          const add = addIdxs.map(i => cur.hand[i]);
          const next = base.concat(add);
          if (!isValidGroup(next)) { showToast("Not a sufficient group"); return; }
          p.laidGroups[gi] = next;
          const keep: Card[] = [];
          cur.hand.forEach((c, i) => { if (!addIdxs.includes(i)) keep.push(c); });
          cur.hand = keep;
          state.selectedIndices = [];
          render();
        });
        grid.appendChild(row);
      });
      p.laidRuns.forEach((r, ri) => {
        const row = document.createElement("div"); row.className = "flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/40 px-2 py-1 slide-in-row";
        const label = document.createElement("span"); label.className = "text-xs font-semibold text-gray-600 dark:text-gray-300 inline-flex items-center gap-1"; label.innerHTML = `<span class='material-symbols-outlined' style='font-size:14px'>alt_route</span><span>Run ${ri + 1}</span>`; row.appendChild(label);
        const cardsWrap = document.createElement("div"); cardsWrap.className = "flex items-center gap-2";
        r.forEach((c) => { const cardEl = document.createElement("div"); cardEl.className = "w-12 aspect-[3/4] rounded-md border bg-center bg-no-repeat bg-contain shadow-sm"; setBackgroundCard(cardEl, c); cardEl.title = formatCard(c); cardEl.addEventListener("mouseenter", (e) => { showHoverPreview(c, (e as MouseEvent).pageX, (e as MouseEvent).pageY); }); cardEl.addEventListener("mousemove", (e) => { moveHoverPreview((e as MouseEvent).pageX, (e as MouseEvent).pageY); }); cardEl.addEventListener("mouseleave", () => { hideHoverPreview(); }); cardsWrap.appendChild(cardEl); });
        row.appendChild(cardsWrap);
        row.addEventListener("dragover", (e) => { e.preventDefault(); });
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          const cur = state.players[state.current];
          if (!cur.laidComplete) { showToast("Lay down first"); return; }
          const raw = e.dataTransfer?.getData("text/plain") || "";
          const idx = Number(raw);
          const addIdxs = state.selectedIndices.length ? state.selectedIndices.slice() : (Number.isFinite(idx) ? [idx] : []);
          if (!addIdxs.length) return;
          if (state.netMode && state.net && p.serverId) {
            state.net.hit(String(p.serverId), "run", ri, addIdxs);
            state.selectedIndices = [];
            return;
          }
          const base = p.laidRuns[ri];
          const add = addIdxs.map(i => cur.hand[i]);
          const next = base.concat(add);
          if (!isValidRun(next)) { showToast("Not a sufficient run"); return; }
          p.laidRuns[ri] = next;
          const keep: Card[] = [];
          cur.hand.forEach((c, i) => { if (!addIdxs.includes(i)) keep.push(c); });
          cur.hand = keep;
          state.selectedIndices = [];
          render();
        });
        grid.appendChild(row);
      });
      sec.appendChild(grid);
      list.appendChild(sec);
    });
    if (!shown) {
      const empty = document.createElement("p"); empty.className = "text-gray-400 dark:text-gray-500"; empty.textContent = "Main Play Area"; elTableArea.appendChild(empty);
    } else {
      elTableArea.appendChild(list);
    }
  }

  const myIdSel = (state.net as NetClient)?.playerId || null;
  const isSpectatorSel = state.netMode && !myIdSel;
  const myIdxSel = !isSpectatorSel && myIdSel ? state.players.findIndex(pp => pp.serverId === myIdSel) : -1;
  const myTurnSel = myIdxSel >= 0 && state.current === myIdxSel;
  if (elTableArea) elTableArea.classList.toggle("my-turn", myTurnSel || (!state.netMode));
  const myHasDrawnSel = myTurnSel ? state.players[myIdxSel].hasDrawn : false;
  const curSel = myTurnSel ? state.selectedIndices.map(i => state.players[myIdxSel].hand[i]) : [];
  const canGroup = myHasDrawnSel && curSel.length >= 3 && isValidGroup(curSel);
  const canRun = myHasDrawnSel && curSel.length >= 4 && isValidRun(curSel);
  if (elBtnLayGroup) {
    elBtnLayGroup.disabled = false;
    elBtnLayGroup.classList.toggle("bg-primary", canGroup);
    elBtnLayGroup.classList.toggle("text-white", canGroup);
    elBtnLayGroup.classList.toggle("bg-white", !canGroup);
    elBtnLayGroup.classList.toggle("text-gray-800", !canGroup);
  }
  if (elBtnLayRun) {
    elBtnLayRun.disabled = false;
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
    if (elDrawBack) {
      elDrawBack.classList.add("shuffle-ripple");
      setTimeout(() => { elDrawBack.classList.remove("shuffle-ripple"); }, 700);
    }
    showToast("Deck reshuffled");
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
  if (state.selectedIndices.length !== 1) { showToast("Select exactly one card to discard"); return; }
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
  if (!cur.hasDrawn) { showToast("Draw first"); return; }
  if (!cur.didDiscard) { showToast("Discard first"); return; }
  if (state.netMode && state.net) {
    state.net.endTurn();
    return;
  }
  nextPlayer();
  render();
  pulse(elBtnLayGroup);
};

if (elBtnGive) elBtnGive.onclick = () => {
  if (state.discardPile.length === 0) return;
  const cur = state.players[state.current];
  if (state.netMode && state.net) {
    const targetServerId = elHitPlayer ? String(elHitPlayer.value) : "";
    if (!targetServerId || (cur.serverId && targetServerId === cur.serverId)) return;
    state.net.giveDiscardTo(targetServerId);
    return;
  }
  const targetId = elHitPlayer ? Number(elHitPlayer.value) : NaN;
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
  if (!cur.hasDrawn) { showToast("Draw first"); return; }
  if (state.selectedIndices.length < 3) { showToast("Pick at least 3 cards for a group"); return; }
  const cards = state.selectedIndices.map(i => cur.hand[i]);
  if (state.netMode && state.net) {
    state.net.layGroup(state.selectedIndices.slice(), (ok, err) => { if (!ok) showToast(err === "count" ? "Pick at least 3 cards" : err === "need_draw" ? "Draw first" : "Not a sufficient group"); });
    state.selectedIndices = [];
    return;
  }
  if (!isValidGroup(cards)) { showToast("Not a sufficient group"); return; }
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
  if (!cur.hasDrawn) { showToast("Draw first"); return; }
  if (state.selectedIndices.length < 4) { showToast("Pick at least 4 cards for a run"); return; }
  const cards = state.selectedIndices.map(i => cur.hand[i]);
  if (state.netMode && state.net) {
    const explain = whyRunInvalid(cards);
    state.net.layRun(state.selectedIndices.slice(), (ok, err) => { if (!ok) showToast(err === "count" ? "Pick at least 4 cards" : err === "need_draw" ? "Draw first" : (explain || "Not a sufficient run")); });
    state.selectedIndices = [];
    return;
  }
  if (!isValidRun(cards)) { const reason = whyRunInvalid(cards) || "Not a sufficient run"; showToast(reason); return; }
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
  if (state.selectedIndices.length === 0) { showToast("Select cards to hit"); return; }
  if (!cur.laidComplete) { showToast("Lay down first"); return; }
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
    if (!base) { showToast("Pick a valid target group"); return; }
    const add = state.selectedIndices.map(i => cur.hand[i]);
    const next = base.concat(add);
    if (!isValidGroup(next)) { showToast("Not a sufficient group"); return; }
    target.laidGroups[idx] = next;
  } else {
    const base = target.laidRuns[idx];
    if (!base) { showToast("Pick a valid target run"); return; }
    const add = state.selectedIndices.map(i => cur.hand[i]);
    const next = base.concat(add);
    if (!isValidRun(next)) { showToast("Not a sufficient run"); return; }
    target.laidRuns[idx] = next;
  }
  const keep: Card[] = [];
  cur.hand.forEach((c, i) => { if (!state.selectedIndices.includes(i)) keep.push(c); });
  cur.hand = keep;
  state.selectedIndices = [];
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
      laidGroups: (sp as any).laidGroups ? sp.laidGroups.map(arr => arr.slice()) : [],
      laidRuns: (sp as any).laidRuns ? sp.laidRuns.map(arr => arr.slice()) : [],
      laidComplete: !!((sp as any).laidComplete),
      totalScore: sp.totalScore,
    }));
    if (elLobbyRoomId) elLobbyRoomId.textContent = `Room: ${s.id}`;
    const myId = (state.net as NetClient).playerId;
    const p1 = s.players[0] || null;
    const p2 = s.players[1] || null;
    const p3 = s.players[2] || null;
    const p4 = s.players[3] || null;
    const p5 = s.players[4] || null;
    const p6 = s.players[5] || null;
    if (elSlot1Status) elSlot1Status.textContent = p1 ? (p1.name + (myId && p1.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot2Status) elSlot2Status.textContent = p2 ? (p2.name + (myId && p2.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot3Status) elSlot3Status.textContent = p3 ? (p3.name + (myId && p3.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot4Status) elSlot4Status.textContent = p4 ? (p4.name + (myId && p4.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot5Status) elSlot5Status.textContent = p5 ? (p5.name + (myId && p5.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot6Status) elSlot6Status.textContent = p6 ? (p6.name + (myId && p6.id === myId ? " (You)" : "")) : "Empty Slot";
    if (elSlot1SummaryStatus) elSlot1SummaryStatus.textContent = p1 ? p1.name : "Empty";
    if (elSlot2SummaryStatus) elSlot2SummaryStatus.textContent = p2 ? p2.name : "Empty";
    if (elSlot3SummaryStatus) elSlot3SummaryStatus.textContent = p3 ? p3.name : "Empty";
    if (elSlot4SummaryStatus) elSlot4SummaryStatus.textContent = p4 ? p4.name : "Empty";
    if (elSlot5SummaryStatus) elSlot5SummaryStatus.textContent = p5 ? p5.name : "Empty";
    if (elSlot6SummaryStatus) elSlot6SummaryStatus.textContent = p6 ? p6.name : "Empty";
    if (elSlot1SummaryReady) elSlot1SummaryReady.textContent = p1 ? (p1.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot2SummaryReady) elSlot2SummaryReady.textContent = p2 ? (p2.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot3SummaryReady) elSlot3SummaryReady.textContent = p3 ? (p3.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot4SummaryReady) elSlot4SummaryReady.textContent = p4 ? (p4.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot5SummaryReady) elSlot5SummaryReady.textContent = p5 ? (p5.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot6SummaryReady) elSlot6SummaryReady.textContent = p6 ? (p6.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot1You) elSlot1You.classList.toggle("hidden", !(p1 && myId && p1.id === myId));
    if (elSlot2You) elSlot2You.classList.toggle("hidden", !(p2 && myId && p2.id === myId));
    if (elSlot3You) elSlot3You.classList.toggle("hidden", !(p3 && myId && p3.id === myId));
    if (elSlot4You) elSlot4You.classList.toggle("hidden", !(p4 && myId && p4.id === myId));
    if (elSlot5You) elSlot5You.classList.toggle("hidden", !(p5 && myId && p5.id === myId));
    if (elSlot6You) elSlot6You.classList.toggle("hidden", !(p6 && myId && p6.id === myId));
    if (elSlot1SummaryYou) elSlot1SummaryYou.classList.toggle("hidden", !(p1 && myId && p1.id === myId));
    if (elSlot2SummaryYou) elSlot2SummaryYou.classList.toggle("hidden", !(p2 && myId && p2.id === myId));
    if (elSlot3SummaryYou) elSlot3SummaryYou.classList.toggle("hidden", !(p3 && myId && p3.id === myId));
    if (elSlot4SummaryYou) elSlot4SummaryYou.classList.toggle("hidden", !(p4 && myId && p4.id === myId));
    if (elSlot5SummaryYou) elSlot5SummaryYou.classList.toggle("hidden", !(p5 && myId && p5.id === myId));
    if (elSlot6SummaryYou) elSlot6SummaryYou.classList.toggle("hidden", !(p6 && myId && p6.id === myId));
    if (elBtnSlot1Take) elBtnSlot1Take.disabled = !!p1 || !!myId;
    if (elBtnSlot2Take) elBtnSlot2Take.disabled = !!p2 || !!myId;
    if (elBtnSlot3Take) elBtnSlot3Take.disabled = !!p3 || !!myId;
    if (elBtnSlot4Take) elBtnSlot4Take.disabled = !!p4 || !!myId;
    if (elBtnSlot5Take) elBtnSlot5Take.disabled = !!p5 || !!myId;
    if (elBtnSlot6Take) elBtnSlot6Take.disabled = !!p6 || !!myId;
    if (elBtnSlot1Leave) elBtnSlot1Leave.disabled = !(p1 && myId && p1.id === myId);
    if (elBtnSlot2Leave) elBtnSlot2Leave.disabled = !(p2 && myId && p2.id === myId);
    if (elBtnSlot3Leave) elBtnSlot3Leave.disabled = !(p3 && myId && p3.id === myId);
    if (elBtnSlot4Leave) elBtnSlot4Leave.disabled = !(p4 && myId && p4.id === myId);
    if (elBtnSlot5Leave) elBtnSlot5Leave.disabled = !(p5 && myId && p5.id === myId);
    if (elBtnSlot6Leave) elBtnSlot6Leave.disabled = !(p6 && myId && p6.id === myId);
    if (elSlot1Ready) elSlot1Ready.textContent = p1 ? (p1.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot2Ready) elSlot2Ready.textContent = p2 ? (p2.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot3Ready) elSlot3Ready.textContent = p3 ? (p3.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot4Ready) elSlot4Ready.textContent = p4 ? (p4.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot5Ready) elSlot5Ready.textContent = p5 ? (p5.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot6Ready) elSlot6Ready.textContent = p6 ? (p6.ready ? "Ready" : "Not Ready") : "Not Ready";
    if (elSlot1Ready) (elSlot1Ready as any).dataset.ready = String(!!(p1 && p1.ready));
    if (elSlot2Ready) (elSlot2Ready as any).dataset.ready = String(!!(p2 && p2.ready));
    if (elSlot3Ready) (elSlot3Ready as any).dataset.ready = String(!!(p3 && p3.ready));
    if (elSlot4Ready) (elSlot4Ready as any).dataset.ready = String(!!(p4 && p4.ready));
    if (elSlot5Ready) (elSlot5Ready as any).dataset.ready = String(!!(p5 && p5.ready));
    if (elSlot6Ready) (elSlot6Ready as any).dataset.ready = String(!!(p6 && p6.ready));
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
    if (elBtnSlot3Ready) {
      const mine3 = !!(p3 && myId && p3.id === myId);
      const slot3Empty = !p3;
      elBtnSlot3Ready.disabled = !(mine3 || slot3Empty);
      elBtnSlot3Ready.textContent = mine3 ? (myReady ? "Unready" : "Ready") : "Ready";
      (elBtnSlot3Ready as any).dataset.ready = String(mine3 ? myReady : false);
    }
    if (elBtnSlot4Ready) {
      const mine4 = !!(p4 && myId && p4.id === myId);
      const slot4Empty = !p4;
      elBtnSlot4Ready.disabled = !(mine4 || slot4Empty);
      elBtnSlot4Ready.textContent = mine4 ? (myReady ? "Unready" : "Ready") : "Ready";
      (elBtnSlot4Ready as any).dataset.ready = String(mine4 ? myReady : false);
    }
    if (elBtnSlot5Ready) {
      const mine5 = !!(p5 && myId && p5.id === myId);
      const slot5Empty = !p5;
      elBtnSlot5Ready.disabled = !(mine5 || slot5Empty);
      elBtnSlot5Ready.textContent = mine5 ? (myReady ? "Unready" : "Ready") : "Ready";
      (elBtnSlot5Ready as any).dataset.ready = String(mine5 ? myReady : false);
    }
    if (elBtnSlot6Ready) {
      const mine6 = !!(p6 && myId && p6.id === myId);
      const slot6Empty = !p6;
      elBtnSlot6Ready.disabled = !(mine6 || slot6Empty);
      elBtnSlot6Ready.textContent = mine6 ? (myReady ? "Unready" : "Ready") : "Ready";
      (elBtnSlot6Ready as any).dataset.ready = String(mine6 ? myReady : false);
    }
    const seats: HTMLDetailsElement[] = [];
    if (elSeat1) seats.push(elSeat1);
    if (elSeat2) seats.push(elSeat2);
    if (elSeat3) seats.push(elSeat3);
    if (elSeat4) seats.push(elSeat4);
    if (elSeat5) seats.push(elSeat5);
    if (elSeat6) seats.push(elSeat6);
    const attachAccordion = () => {
      if (seats.length === 0) return;
      const w = window.innerWidth || 0;
      if (w <= 480) {
        // default: open the seat the user occupies, else first
        const myIdx = myId ? s.players.findIndex(x => x.id === myId) : -1;
        seats.forEach((d, i) => { d.open = i === (myIdx >= 0 ? myIdx : 0); });
      }
    };
    const onToggle = (e: Event) => {
      const w = window.innerWidth || 0;
      if (w > 480) return;
      const tgt = e.currentTarget as HTMLDetailsElement;
      if (!tgt.open) return;
      seats.forEach(d => { if (d !== tgt) d.open = false; });
    };
    seats.forEach(d => {
      const key = (d as any).dataset?.acc || "false";
      if (key !== "true") { d.addEventListener("toggle", onToggle); (d as any).dataset.acc = "true"; }
    });
    attachAccordion();
    const allReady = s.players.length >= 2 && s.players.every(x => x.ready);
    if (elLobbyReadyChip) {
      const rc = s.players.filter(x => x.ready).length;
      elLobbyReadyChip.textContent = `${rc}/6 ready`;
    }
  if (elBtnLobbyStart) {
    const isPlayer = !!myId && s.players.some(x => x.id === myId);
    elBtnLobbyStart.disabled = (s.players.length < 2) || s.started || !isPlayer;
  }
  if (elLobbyTimer) elLobbyTimer.classList.add("hidden");
  if (elBtnLobbyExtend) elBtnLobbyExtend.classList.add("hidden");
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
  if (state.netMode) {
    const sNet = state.net as NetClient;
    elMpInfo.textContent = `Room: ${sNet.roomId}`;
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
  const canPlay = !summary.started && summary.players.length < 4;
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
      if (elLobbyReadyChip) elLobbyReadyChip.textContent = "0/6 ready";
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
        if (elLobbyReadyChip) elLobbyReadyChip.textContent = `${r1 + r2}/6 ready`;
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
if (elBtnSlot3Take) { elBtnSlot3Take.onclick = () => { const name = elMpName.value || "Player"; state.net?.takeSeatAt(name, 2, (ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Seated at 3" : "Failed"; if (ok && elBtnSlot3Ready) { elBtnSlot3Ready.disabled = false; elBtnSlot3Ready.textContent = "Ready"; (elBtnSlot3Ready as any).dataset.ready = "false"; } }); }; }
if (elBtnSlot4Take) { elBtnSlot4Take.onclick = () => { const name = elMpName.value || "Player"; state.net?.takeSeatAt(name, 3, (ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Seated at 4" : "Failed"; if (ok && elBtnSlot4Ready) { elBtnSlot4Ready.disabled = false; elBtnSlot4Ready.textContent = "Ready"; (elBtnSlot4Ready as any).dataset.ready = "false"; } }); }; }
if (elBtnSlot5Take) { elBtnSlot5Take.onclick = () => { const name = elMpName.value || "Player"; state.net?.takeSeatAt(name, 4, (ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Seated at 5" : "Failed"; if (ok && elBtnSlot5Ready) { elBtnSlot5Ready.disabled = false; elBtnSlot5Ready.textContent = "Ready"; (elBtnSlot5Ready as any).dataset.ready = "false"; } }); }; }
if (elBtnSlot6Take) { elBtnSlot6Take.onclick = () => { const name = elMpName.value || "Player"; state.net?.takeSeatAt(name, 5, (ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Seated at 6" : "Failed"; if (ok && elBtnSlot6Ready) { elBtnSlot6Ready.disabled = false; elBtnSlot6Ready.textContent = "Ready"; (elBtnSlot6Ready as any).dataset.ready = "false"; } }); }; }
if (elBtnSlot1Leave) { elBtnSlot1Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot1Take) elBtnSlot1Take.disabled = false; if (elBtnSlot1Ready) { elBtnSlot1Ready.disabled = true; elBtnSlot1Ready.textContent = "Ready"; (elBtnSlot1Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot2Leave) { elBtnSlot2Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot2Take) elBtnSlot2Take.disabled = false; if (elBtnSlot2Ready) { elBtnSlot2Ready.disabled = true; elBtnSlot2Ready.textContent = "Ready"; (elBtnSlot2Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot3Leave) { elBtnSlot3Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot3Take) elBtnSlot3Take.disabled = false; if (elBtnSlot3Ready) { elBtnSlot3Ready.disabled = true; elBtnSlot3Ready.textContent = "Ready"; (elBtnSlot3Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot4Leave) { elBtnSlot4Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot4Take) elBtnSlot4Take.disabled = false; if (elBtnSlot4Ready) { elBtnSlot4Ready.disabled = true; elBtnSlot4Ready.textContent = "Ready"; (elBtnSlot4Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot5Leave) { elBtnSlot5Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot5Take) elBtnSlot5Take.disabled = false; if (elBtnSlot5Ready) { elBtnSlot5Ready.disabled = true; elBtnSlot5Ready.textContent = "Ready"; (elBtnSlot5Ready as any).dataset.ready = "false"; } } }); }; }
if (elBtnSlot6Leave) { elBtnSlot6Leave.onclick = () => { state.net?.leaveSeat((ok) => { if (elLobbyStatus) elLobbyStatus.textContent = ok ? "Left seat" : "Cannot leave during hand"; if (ok) { if (elBtnSlot6Take) elBtnSlot6Take.disabled = false; if (elBtnSlot6Ready) { elBtnSlot6Ready.disabled = true; elBtnSlot6Ready.textContent = "Ready"; (elBtnSlot6Ready as any).dataset.ready = "false"; } } }); }; }
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
if (elBtnSlot3Ready) {
  elBtnSlot3Ready.onclick = () => {
    const cur = (elSlot3Ready as any)?.dataset?.ready === "true";
    const next = !cur;
    const name = elMpName.value || "Player";
    if (!state.net?.playerId) {
      state.net?.takeSeatAt(name, 2, (ok) => {
        if (!ok) { if (elLobbyStatus) elLobbyStatus.textContent = "Seat 3 occupied"; return; }
        state.net?.setSeatReady(2, next, (ok2) => { if (!ok2 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 3"; });
      });
      return;
    }
    state.net?.setSeatReady(2, next, (ok3) => { if (!ok3 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 3"; });
  };
}
if (elBtnSlot4Ready) {
  elBtnSlot4Ready.onclick = () => {
    const cur = (elSlot4Ready as any)?.dataset?.ready === "true";
    const next = !cur;
    const name = elMpName.value || "Player";
    if (!state.net?.playerId) {
      state.net?.takeSeatAt(name, 3, (ok) => {
        if (!ok) { if (elLobbyStatus) elLobbyStatus.textContent = "Seat 4 occupied"; return; }
        state.net?.setSeatReady(3, next, (ok2) => { if (!ok2 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 4"; });
      });
      return;
    }
    state.net?.setSeatReady(3, next, (ok3) => { if (!ok3 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 4"; });
  };
}
if (elBtnSlot5Ready) {
  elBtnSlot5Ready.onclick = () => {
    const cur = (elSlot5Ready as any)?.dataset?.ready === "true";
    const next = !cur;
    const name = elMpName.value || "Player";
    if (!state.net?.playerId) {
      state.net?.takeSeatAt(name, 4, (ok) => {
        if (!ok) { if (elLobbyStatus) elLobbyStatus.textContent = "Seat 5 occupied"; return; }
        state.net?.setSeatReady(4, next, (ok2) => { if (!ok2 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 5"; });
      });
      return;
    }
    state.net?.setSeatReady(4, next, (ok3) => { if (!ok3 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 5"; });
  };
}
if (elBtnSlot6Ready) {
  elBtnSlot6Ready.onclick = () => {
    const cur = (elSlot6Ready as any)?.dataset?.ready === "true";
    const next = !cur;
    const name = elMpName.value || "Player";
    if (!state.net?.playerId) {
      state.net?.takeSeatAt(name, 5, (ok) => {
        if (!ok) { if (elLobbyStatus) elLobbyStatus.textContent = "Seat 6 occupied"; return; }
        state.net?.setSeatReady(5, next, (ok2) => { if (!ok2 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 6"; });
      });
      return;
    }
    state.net?.setSeatReady(5, next, (ok3) => { if (!ok3 && elLobbyStatus) elLobbyStatus.textContent = "Cannot mark ready for seat 6"; });
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
if (elBtnHandBack) { elBtnHandBack.onclick = () => { state.stage = "find"; render(); }; }
if (elBtnNextHand) {
  elBtnNextHand.onclick = () => {
    if (state.netMode && state.net) {
      state.net.nextHand((ok, err) => {
        if (!ok) {
          if (err === "not_complete") showToast("Hand not complete yet");
          else if (err === "match_complete") showToast("Match complete");
          else showToast("Unable to start next hand");
        }
      });
      return;
    }
    // Local mode fallback: start next hand
    state.handNumber = Math.min(6, state.handNumber + 1);
    const deck = new Deck(createDoubleDeck(true));
    deck.shuffle();
    const dealCount = getDealCountForHand(state.handNumber);
    state.players.forEach((p) => {
      p.hand = [];
      for (let j = 0; j < dealCount; j++) {
        const c = deck.draw();
        if (c) p.hand.push(c);
      }
      p.hasDrawn = false;
      p.didDiscard = false;
      p.laidGroups = [];
      p.laidRuns = [];
      p.laidComplete = false;
    });
    const discardFirst = deck.draw();
    state.drawPile = deck;
    state.discardPile = discardFirst ? [discardFirst] : [];
    state.current = 0;
    state.lastScores = [];
    state.stage = "game";
    render();
  };
}

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
if (elSlot3Ready) (elSlot3Ready as any).dataset.ready = "false";
if (elSlot4Ready) (elSlot4Ready as any).dataset.ready = "false";
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
if (elDiscardTop) {
  elDiscardTop.addEventListener("dragover", (e) => { e.preventDefault(); });
  elDiscardTop.addEventListener("drop", (e) => {
    e.preventDefault();
    const cur = state.players[state.current];
    if (!cur.hasDrawn) { showToast("Draw first"); return; }
    const raw = e.dataTransfer?.getData("text/plain") || "";
    const idx = Number(raw);
    if (!Number.isFinite(idx)) return;
    state.selectedIndices = [idx];
    elBtnDiscard.click();
  });
}
const elSeat1 = document.getElementById("seat1") as HTMLDetailsElement;
const elSeat2 = document.getElementById("seat2") as HTMLDetailsElement;
const elSeat3 = document.getElementById("seat3") as HTMLDetailsElement;
const elSeat4 = document.getElementById("seat4") as HTMLDetailsElement;
const elSeat5 = document.getElementById("seat5") as HTMLDetailsElement;
const elSeat6 = document.getElementById("seat6") as HTMLDetailsElement;
const elSlot1SummaryStatus = document.getElementById("slot1-summary-status") as HTMLElement;
const elSlot2SummaryStatus = document.getElementById("slot2-summary-status") as HTMLElement;
const elSlot3SummaryStatus = document.getElementById("slot3-summary-status") as HTMLElement;
const elSlot4SummaryStatus = document.getElementById("slot4-summary-status") as HTMLElement;
const elSlot5SummaryStatus = document.getElementById("slot5-summary-status") as HTMLElement;
const elSlot6SummaryStatus = document.getElementById("slot6-summary-status") as HTMLElement;
const elSlot1SummaryReady = document.getElementById("slot1-summary-ready") as HTMLElement;
const elSlot2SummaryReady = document.getElementById("slot2-summary-ready") as HTMLElement;
const elSlot3SummaryReady = document.getElementById("slot3-summary-ready") as HTMLElement;
const elSlot4SummaryReady = document.getElementById("slot4-summary-ready") as HTMLElement;
const elSlot5SummaryReady = document.getElementById("slot5-summary-ready") as HTMLElement;
const elSlot6SummaryReady = document.getElementById("slot6-summary-ready") as HTMLElement;
const elSlot1SummaryYou = document.getElementById("slot1-summary-you") as HTMLElement;
const elSlot2SummaryYou = document.getElementById("slot2-summary-you") as HTMLElement;
const elSlot3SummaryYou = document.getElementById("slot3-summary-you") as HTMLElement;
const elSlot4SummaryYou = document.getElementById("slot4-summary-you") as HTMLElement;
const elSlot5SummaryYou = document.getElementById("slot5-summary-you") as HTMLElement;
const elSlot6SummaryYou = document.getElementById("slot6-summary-you") as HTMLElement;
