import { Card, isWild } from "./card";

export function cardPoints(card: Card): number {
  if (isWild(card) && card.rank === "Joker") return 50;
  if (card.rank === 2) return 20;
  if (typeof card.rank === "number") {
    if (card.rank >= 3 && card.rank <= 9) return 5;
    if (card.rank === 10) return 10;
  }
  if (card.rank === "J" || card.rank === "Q" || card.rank === "K") return 10;
  if (card.rank === "A") return 15;
  return 0;
}

export function scoreHand(cards: Card[]): number {
  let total = 0;
  for (const c of cards) total += cardPoints(c);
  return total;
}