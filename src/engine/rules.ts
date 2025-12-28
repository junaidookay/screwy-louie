import { Card, Rank, Suit, isWild, rankValue } from "./card";

export function isValidGroup(cards: Card[]): boolean {
  if (cards.length < 3) return false;
  const nonWild = cards.filter(c => !isWild(c));
  if (nonWild.length === 0) return true;
  const first = nonWild[0].rank;
  for (let i = 1; i < nonWild.length; i++) {
    if (nonWild[i].rank !== first) return false;
  }
  return true;
}

function isNonWildRunSuitConsistent(cards: Card[]): boolean {
  const nonWild = cards.filter(c => !isWild(c));
  if (nonWild.length === 0) return true;
  const s = nonWild[0].suit as Suit;
  for (let i = 1; i < nonWild.length; i++) {
    if (nonWild[i].suit !== s) return false;
  }
  return true;
}

function ranksAreValidForRun(cards: Card[]): boolean {
  const nonWild = cards.filter(c => !isWild(c));
  for (const c of nonWild) {
    const v = rankValue(c.rank);
    if (v < 3 || v > 14) return false;
  }
  return true;
}

export function isValidRun(cards: Card[]): boolean {
  if (cards.length < 4) return false;
  if (!isNonWildRunSuitConsistent(cards)) return false;
  if (!ranksAreValidForRun(cards)) return false;
  const nonWild = cards.filter(c => !isWild(c));
  const wildCount = cards.length - nonWild.length;
  if (cards.length > 12) return false;
  const values = nonWild.map(c => rankValue(c.rank)).sort((a, b) => a - b);
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) return false;
  }
  if (values.length === 0) return cards.length <= 12;
  const first = values[0];
  const last = values[values.length - 1];
  const spanLength = last - first + 1;
  let neededWilds = 0;
  for (let i = 1; i < values.length; i++) {
    const gap = values[i] - values[i - 1] - 1;
    if (gap > 0) neededWilds += gap;
  }
  const remainingWilds = wildCount - neededWilds;
  if (remainingWilds < 0) return false;
  const spaceLeft = first - 3;
  const spaceRight = 14 - last;
  const maxExtend = spaceLeft + spaceRight;
  if (remainingWilds > maxExtend) return false;
  const finalLength = spanLength + remainingWilds;
  if (finalLength !== cards.length) return false;
  return true;
}

// Human-friendly reason when a run is invalid
export function whyRunInvalid(cards: Card[]): string | null {
  if (cards.length < 4) return "Pick at least 4 cards for a run";
  if (!isNonWildRunSuitConsistent(cards)) return "All non-wild cards must be the same suit";
  if (!ranksAreValidForRun(cards)) return "Runs use ranks 3 through A (A is high)";
  const nonWild = cards.filter(c => !isWild(c));
  const wildCount = cards.length - nonWild.length;
  if (cards.length > 12) return "Runs cannot be longer than 12 cards";
  const values = nonWild.map(c => rankValue(c.rank)).sort((a, b) => a - b);
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) return "Duplicate ranks among non-wilds";
  }
  if (values.length === 0) return null; // all wilds is allowed up to 12
  const first = values[0];
  const last = values[values.length - 1];
  const spanLength = last - first + 1;
  let neededWilds = 0;
  for (let i = 1; i < values.length; i++) {
    const gap = values[i] - values[i - 1] - 1;
    if (gap > 0) neededWilds += gap;
  }
  const remainingWilds = wildCount - neededWilds;
  if (remainingWilds < 0) return "Not enough wilds to fill the gaps";
  const spaceLeft = first - 3;
  const spaceRight = 14 - last;
  const maxExtend = spaceLeft + spaceRight;
  if (remainingWilds > maxExtend) return "Too many wilds left over to extend the sequence";
  const finalLength = spanLength + remainingWilds;
  if (finalLength !== cards.length) return "Wilds do not match run length";
  return null;
}

function suitValue(suit: Suit | undefined): number {
  if (suit === "Clubs") return 1;
  if (suit === "Diamonds") return 2;
  if (suit === "Hearts") return 3;
  if (suit === "Spades") return 4;
  return 99;
}

export function orderGroupForDisplay(cards: Card[]): Card[] {
  const wilds: Card[] = [];
  const nonWild: Card[] = [];
  for (const c of cards) {
    if (isWild(c)) wilds.push(c);
    else nonWild.push(c);
  }
  nonWild.sort((a, b) => {
    const ra = rankValue(a.rank);
    const rb = rankValue(b.rank);
    if (ra !== rb) return ra - rb;
    return suitValue(a.suit) - suitValue(b.suit);
  });
  return nonWild.concat(wilds);
}

export function orderRunForDisplay(cards: Card[]): Card[] {
  const snapshot = cards.slice();
  if (!isValidRun(snapshot)) return snapshot;
  const wilds: Card[] = [];
  const nonWild: Card[] = [];
  for (const c of snapshot) {
    if (isWild(c)) wilds.push(c);
    else nonWild.push(c);
  }
  if (nonWild.length === 0) return wilds;
  const byValue = new Map<number, Card>();
  for (const c of nonWild) byValue.set(rankValue(c.rank), c);
  const values = Array.from(byValue.keys()).sort((a, b) => a - b);
  const first = values[0];
  const last = values[values.length - 1];
  let neededWilds = 0;
  for (let i = 1; i < values.length; i++) {
    const gap = values[i] - values[i - 1] - 1;
    if (gap > 0) neededWilds += gap;
  }
  let remainingWilds = wilds.length - neededWilds;
  if (remainingWilds < 0) return snapshot;
  const extendLeft = Math.min(remainingWilds, first - 3);
  remainingWilds -= extendLeft;
  const extendRight = Math.min(remainingWilds, 14 - last);
  const start = first - extendLeft;
  const end = last + extendRight;
  const out: Card[] = [];
  let wi = 0;
  for (let v = start; v <= end; v++) {
    const c = byValue.get(v);
    if (c) out.push(c);
    else out.push(wilds[wi++]);
  }
  return out;
}
