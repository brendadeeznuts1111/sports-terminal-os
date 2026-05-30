import { describe, it, expect } from "bun:test";
import {
  normalizeTeam,
  jaroWinkler,
  sorensenDice,
  fuzzyScore,
  findBestMatch,
  findAllMatches,
} from "../../src/utils/fuzzy-matcher";

describe("normalizeTeam", () => {
  it("removes parenthetical suffixes", () => {
    expect(normalizeTeam("Portland Fire (w)")).toBe("portland fire");
    expect(normalizeTeam("Manchester City (U23)")).toBe("manchester city");
    expect(normalizeTeam("LA Sparks (women)")).toBe("la sparks");
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeTeam("  MAN   CITY  ")).toBe("man city");
  });

  it("removes punctuation", () => {
    expect(normalizeTeam("St. Pauli")).toBe("st pauli");
    expect(normalizeTeam("N'Golo Kante")).toBe("n golo kante");
  });

  it("handles empty strings", () => {
    expect(normalizeTeam("")).toBe("");
  });
});

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("man city", "man city")).toBe(1);
  });

  it("returns 0 for empty strings", () => {
    expect(jaroWinkler("", "man city")).toBe(0);
    expect(jaroWinkler("man city", "")).toBe(0);
  });

  it("handles typical abbreviation with prefix match", () => {
    const score = jaroWinkler("manchester city", "man city");
    expect(score).toBeGreaterThan(0.7);
  });

  it("gives low score for completely different strings", () => {
    const score = jaroWinkler("liverpool", "real madrid");
    expect(score).toBeLessThan(0.5);
  });
});

describe("sorensenDice", () => {
  it("returns 1 for identical strings", () => {
    expect(sorensenDice("man city", "man city")).toBe(1);
  });

  it("handles bigram overlap for near matches", () => {
    const score = sorensenDice("man city", "manchester city");
    expect(score).toBeGreaterThan(0.4);
  });

  it("returns 0 for no overlap", () => {
    const score = sorensenDice("abc", "xyz");
    expect(score).toBe(0);
  });
});

describe("fuzzyScore hybrid", () => {
  it("matches Portland Fire with suffix", () => {
    const score = fuzzyScore("Portland Fire", "Portland Fire (w)");
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it("matches Man City to Manchester City at relaxed threshold", () => {
    // Abbreviation gap: "Man City" (7 chars) vs "Manchester City" (15 chars).
    // JW=0.757, Dice=0.571 → hybrid=0.644. Passes at 0.6 threshold.
    const score = fuzzyScore("Man City", "Manchester City", 0.6);
    expect(score).toBeGreaterThan(0.6);
  });

  it("matches Manchester City FC to Manchester City", () => {
    const score = fuzzyScore("Manchester City FC", "Manchester City");
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  it("returns 0 for completely different teams", () => {
    expect(fuzzyScore("Liverpool", "Real Madrid")).toBe(0);
  });

  it("respects threshold", () => {
    expect(fuzzyScore("Golden State", "Golden State Warriors", 0.9)).toBe(0);
    expect(fuzzyScore("Golden State", "Golden State Warriors", 0.7)).toBeGreaterThan(0);
  });

  it("returns 1 for exact match after normalization", () => {
    expect(fuzzyScore("portland fire", "Portland Fire (w)")).toBe(1);
  });
});

describe("findBestMatch", () => {
  const candidates = ["Portland Fire (w)", "Manchester City", "Real Madrid", "LA Sparks"];

  it("picks correct match for exact normalized", () => {
    const res = findBestMatch("Portland Fire", candidates);
    expect(res).not.toBeNull();
    expect(res!.match).toBe("Portland Fire (w)");
    expect(res!.score).toBeGreaterThan(0.9);
  });

  it("returns null when no candidate matches", () => {
    const res = findBestMatch("Unknown FC", candidates, 0.85);
    expect(res).toBeNull();
  });

  it("returns exact match early", () => {
    const res = findBestMatch("LA Sparks", candidates);
    expect(res).not.toBeNull();
    expect(res!.match).toBe("LA Sparks");
    expect(res!.score).toBe(1);
    expect(res!.method).toBe("exact");
  });
});

describe("findAllMatches", () => {
  const candidates = [
    "Portland Fire (w)",
    "Portland Trail Blazers",
    "Manchester City",
    "Real Madrid",
  ];

  it("returns multiple matches above threshold", () => {
    const res = findAllMatches("Portland", candidates, 0.5);
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(res[0].match).toBe("Portland Fire (w)");
  });

  it("returns empty array for no matches", () => {
    const res = findAllMatches("Barcelona", candidates, 0.9);
    expect(res).toEqual([]);
  });

  it("sorts by score descending", () => {
    const res = findAllMatches("Portland", candidates, 0.3);
    for (let i = 0; i < res.length - 1; i++) {
      expect(res[i].score).toBeGreaterThanOrEqual(res[i + 1].score);
    }
  });
});
