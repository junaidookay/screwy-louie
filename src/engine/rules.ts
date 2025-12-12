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
