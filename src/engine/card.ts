export type Suit = "Clubs" | "Diamonds" | "Hearts" | "Spades";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | "J" | "Q" | "K" | "A" | "Joker";

export interface Card {
  suit?: Suit;
  rank: Rank;
}

export function isJoker(card: Card): boolean {
  return card.rank === "Joker";
}

export function isTwo(card: Card): boolean {
  return card.rank === 2;
}

export function isWild(card: Card): boolean {
  return isJoker(card) || isTwo(card);
}

export const orderedRanks: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, "J", "Q", "K", "A"];

export function rankValue(rank: Rank): number {
  if (typeof rank === "number") return rank;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  if (rank === "A") return 14;
  return 0;
}

export function createStandardDeck(includeJokers: boolean): Card[] {
  const deck: Card[] = [];
  const suits: Suit[] = ["Clubs", "Diamonds", "Hearts", "Spades"];
  for (const suit of suits) {
    for (const rank of orderedRanks) {
      if (rank === 2) continue;
      deck.push({ suit, rank });
    }
    deck.push({ suit, rank: 2 });
  }
  if (includeJokers) {
    deck.push({ rank: "Joker" });
    deck.push({ rank: "Joker" });
  }
  return deck;
}

export function createDoubleDeck(includeJokers: boolean): Card[] {
  return [...createStandardDeck(includeJokers), ...createStandardDeck(includeJokers)];
}