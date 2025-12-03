import { Card, Suit, createDoubleDeck, isWild } from "../engine/card";
import { Deck } from "../engine/deck";
import { isValidGroup, isValidRun } from "../engine/rules";
import { scoreHand } from "../engine/scoring";
import { getDealCountForHand, getPhaseRequirementsForHand } from "../engine/game";

function pick(cards: Card[], predicate: (c: Card) => boolean, count: number): Card[] {
  const res: Card[] = [];
  for (const c of cards) {
    if (predicate(c)) res.push(c);
    if (res.length === count) break;
  }
  return res;
}

function suitRunExample(suit: Suit): Card[] {
  return [
    { suit, rank: 3 },
    { suit, rank: 4 },
    { suit, rank: 5 },
    { suit, rank: 6 }
  ];
}

function wildRunExample(suit: Suit): Card[] {
  return [
    { suit, rank: 3 },
    { suit, rank: 5 },
    { rank: "Joker" },
    { suit, rank: 6 }
  ];
}

function groupExample(): Card[] {
  return [
    { suit: "Hearts", rank: 8 },
    { suit: "Spades", rank: 8 },
    { suit: "Clubs", rank: 8 }
  ];
}

function main(): void {
  const deckCards = createDoubleDeck(true);
  const deck = new Deck(deckCards);
  deck.shuffle();
  const deal1 = getDealCountForHand(1);
  const phases1 = getPhaseRequirementsForHand(1);
  if (deal1 !== 7) throw new Error("deal1");
  if (phases1.length !== 1 || phases1[0].type !== "group" || phases1[0].count !== 2) throw new Error("phase1");
  const runA = suitRunExample("Hearts");
  if (!isValidRun(runA)) throw new Error("runA");
  const runB = wildRunExample("Diamonds");
  if (!isValidRun(runB)) throw new Error("runB");
  const grp = groupExample();
  if (!isValidGroup(grp)) throw new Error("group");
  const points = scoreHand([{ rank: "Joker" }, { suit: "Clubs", rank: 2 }, { suit: "Hearts", rank: 10 }, { suit: "Spades", rank: "A" }]);
  if (points !== 50 + 20 + 10 + 15) throw new Error("score");
  const sampleHand: Card[] = [];
  for (let i = 0; i < 7; i++) {
    const c = deck.draw();
    if (!c) throw new Error("draw");
    sampleHand.push(c);
  }
  const total = scoreHand(sampleHand);
  if (typeof total !== "number") throw new Error("hand");
  console.log("OK", { deckSize: deck.size(), sampleScore: total });
}

main();