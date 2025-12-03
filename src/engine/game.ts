export type PhaseRequirement = { type: "group" | "run"; count: number };

export function getPhaseRequirementsForHand(hand: number): PhaseRequirement[] {
  if (hand === 1) return [{ type: "group", count: 2 }];
  if (hand === 2) return [{ type: "group", count: 1 }, { type: "run", count: 1 }];
  if (hand === 3) return [{ type: "run", count: 2 }];
  if (hand === 4) return [{ type: "group", count: 3 }];
  if (hand === 5) return [{ type: "group", count: 2 }, { type: "run", count: 1 }];
  if (hand === 6) return [{ type: "group", count: 1 }, { type: "run", count: 2 }];
  return [];
}

export function getDealCountForHand(hand: number): number {
  if (hand === 1) return 7;
  if (hand === 2) return 8;
  if (hand === 3) return 9;
  if (hand === 4) return 10;
  if (hand === 5) return 11;
  if (hand === 6) return 12;
  return 7;
}