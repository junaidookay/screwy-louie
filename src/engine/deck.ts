import { Card } from "./card";

export class Deck {
  private cards: Card[];

  constructor(cards: Card[]) {
    this.cards = cards.slice();
  }

  shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = this.cards[i];
      this.cards[i] = this.cards[j];
      this.cards[j] = tmp;
    }
  }

  draw(): Card | undefined {
    return this.cards.pop();
  }

  size(): number {
    return this.cards.length;
  }

  toArray(): Card[] {
    return this.cards.slice();
  }
}