/**
 * Fuzzy Matcher — Team Name Aliasing & Source Reconciliation
 *
 * Hybrid algorithm: Jaro-Winkler (primary) + Sørensen-Dice (secondary)
 * + optional Double Metaphone boost. All zero-dependency, Bun-native.
 *
 * Used by:
 *   - Odds event matching (Pinnacle event names → DB events)
 *   - Partner profile team resolution
 *   - Buckeye wager team → sportsbook odds reconciliation
 *
 * All functions are pure — no side effects, no I/O.
 */

// ---------------------------------------------------------------------------
// Normalization — always run FIRST
// ---------------------------------------------------------------------------

/** Strip noise from team names before comparison. */
export function normalizeTeam(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s*\([^)]+\)/g, "")           // remove (w), (m), (U23), (women)
    .replace(/[^a-z0-9\s]/g, " ")           // keep only alphanum + space
    .replace(/\s+/g, " ")                   // collapse whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// Jaro-Winkler — primary algorithm
// ---------------------------------------------------------------------------

/**
 * Jaro-Winkler similarity. Range [0, 1].
 * Excellent for short team names with common prefixes (e.g. "Man City" vs "Manchester City").
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Matching window
  const matchDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;

  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);

    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Transpositions
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = Math.floor(transpositions / 2);

  // Jaro similarity
  const jaro =
    (matches / a.length +
      matches / b.length +
      (matches - transpositions) / matches) /
    3;

  // Winkler prefix boost (max 4 chars)
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(a.length, b.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  const SCALING = 0.1;
  return jaro + prefix * SCALING * (1 - jaro);
}

// ---------------------------------------------------------------------------
// Sørensen-Dice — secondary (token overlap)
// ---------------------------------------------------------------------------

/**
 * Sørensen-Dice coefficient via bigrams. Range [0, 1].
 * Good for multi-word names where token order varies.
 */
export function sorensenDice(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return a === b ? 1.0 : 0.0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));

  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

// ---------------------------------------------------------------------------
// Double Metaphone — phonetic boost
// ---------------------------------------------------------------------------

/**
 * Simplified Double Metaphone. Encodes a name into a sound-alike key.
 * Uses a sports-team abbreviation lookup as a fast path, then falls
 * back to phonetic rules for unknown tokens.
 */
function metaphoneEncode(word: string): string {
  if (word.length === 0) return "";

  const s = word.toLowerCase();

  // Fast path: sports-team abbreviation lookup table
  const abbrev: Record<string, string> = {
    manchester: "MNX", man: "MN", city: "ST", united: "ANTD", utd: "ATD",
    town: "TN", athletic: "A0LK", sporting: "SPRTK", real: "RL",
    fc: "", sc: "", ac: "AK", cf: "KF", afc: "AFK", county: "KNT",
    wanderers: "WNTR", rovers: "RFR", rangers: "RNJR", albion: "ALBN",
    olympic: "ALMP", dynamo: "DNM", lokomotiv: "LKMT", spartak: "SPRT",
    cska: "CSK", zenit: "ZNT", portland: "PRTL", seattle: "STL",
    golden: "GLDN", state: "STT", angeles: "ANJL", york: "YRK",
    warriors: "WRR", lakers: "LKR", knicks: "NKS", celtics: "SLTK",
    bulls: "BLS", spurs: "SPRS", rockets: "RKT", mavericks: "MFRK",
    heat: "HT", thunder: "0NDR", trail: "TRL", blazers: "BLSR",
  };

  const tokens = s.split(/\s+/);
  let code = "";
  for (const token of tokens) {
    if (abbrev[token] !== undefined) {
      code += abbrev[token];
    } else {
      code += token;
    }
  }
  if (code) return code.slice(0, 8);

  // Fallback: phonetic rules for unknown tokens
  const result: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/^kn/, "n"], [/^gn/, "n"], [/^pn/, "n"], [/^wr/, "r"],
    [/^wh/, "w"], [/^x/, "s"],
    [/gh$/, ""], [/ght/, "t"],
    [/ph/, "f"], [/sh/, "x"], [/sch/, "s"], [/th/, "0"],
    [/ch/, "c"], [/ck/, "k"], [/dg/, "j"],
    [/cia/, "xa"], [/tia/, "xa"], [/tio/, "xo"],
    [/tion/, "xn"],
    [/([aeiou])y/, "$1y"], [/y/, "i"],
    [/c(?=[eiy])/, "s"], [/c/, "k"],
    [/g(?=[eiy])/, "j"], [/g/, "g"],
    [/d(?=g[ei])/, ""], [/d/, "t"],
    [/b(?=b)/, ""], [/p(?=p)/, ""], [/t(?=t)/, ""],
    [/[aeiou]/g, "a"],
  ];

  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (const [pattern, replacement] of rules) {
      const m = s.slice(i).match(pattern);
      if (m && m.index === 0) {
        result.push(replacement);
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result.push(s[i]);
      i++;
    }
  }

  // Deduplicate consecutive chars
  const deduped: string[] = [];
  for (const ch of result.join("").split("")) {
    if (deduped[deduped.length - 1] !== ch) deduped.push(ch);
  }

  return deduped.join("").slice(0, 8);
}

/**
 * Double Metaphone boost. Returns [0, 1] bonus for phonetic match.
 */
function doubleMetaphoneBoost(a: string, b: string): number {
  const ma = metaphoneEncode(a);
  const mb = metaphoneEncode(b);
  if (ma === "" || mb === "") return 0;
  if (ma === mb) return 1.0;

  // Partial prefix match on Metaphone keys
  const minLen = Math.min(ma.length, mb.length);
  if (minLen === 0) return 0;

  let prefixMatch = 0;
  for (let i = 0; i < minLen; i++) {
    if (ma[i] === mb[i]) prefixMatch++;
    else break;
  }

  return (prefixMatch / minLen) * 0.5; // Partial credit
}

// ---------------------------------------------------------------------------
// Hybrid Matcher — the single entry point
// ---------------------------------------------------------------------------

export interface MatchResult {
  match: string;
  score: number;
  /** Which algorithm contributed most: "exact" | "jaro-winkler" | "dice" | "metaphone" */
  method: "exact" | "jaro-winkler" | "dice" | "metaphone" | "hybrid";
}

/**
 * Compute fuzzy similarity score between two team names.
 *
 * @param a  Query string (e.g. "Portland Fire")
 * @param b  Candidate string (e.g. "Portland Fire (w)")
 * @param threshold  Minimum score to consider a match. Default 0.88.
 * @returns Score [0, 1] if above threshold, 0 otherwise.
 */
export function fuzzyScore(a: string, b: string, threshold = 0.88): number {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);

  if (na === nb) return 1.0;
  if (na.length === 0 || nb.length === 0) return 0.0;

  const jw = jaroWinkler(na, nb);
  const dice = sorensenDice(na, nb);
  const metaBoost = doubleMetaphoneBoost(na, nb);

  // Weighted hybrid: Jaro-Winkler 70%, Dice 20%, Metaphone 10%
  const hybrid = jw * 0.7 + dice * 0.2 + metaBoost * 0.1;

  return hybrid >= threshold ? Math.round(hybrid * 10000) / 10000 : 0;
}

/**
 * Find the best matching candidate from a list.
 *
 * @returns Best match if score > 0, null if no match found.
 */
export function findBestMatch(
  query: string,
  candidates: string[],
  threshold = 0.88
): MatchResult | null {
  let best: MatchResult = { match: "", score: 0, method: "exact" };

  const queryNorm = normalizeTeam(query);
  const normCache = new Map<string, string>();

  for (const c of candidates) {
    let candNorm = normCache.get(c);
    if (!candNorm) {
      candNorm = normalizeTeam(c);
      normCache.set(c, candNorm);
    }

    if (queryNorm === candNorm) {
      return { match: c, score: 1.0, method: "exact" };
    }

    const jw = jaroWinkler(queryNorm, candNorm);
    const dice = sorensenDice(queryNorm, candNorm);
    const metaBoost = doubleMetaphoneBoost(queryNorm, candNorm);
    const hybrid = jw * 0.7 + dice * 0.2 + metaBoost * 0.1;

    if (hybrid > best.score) {
      best = {
        match: c,
        score: Math.round(hybrid * 10000) / 10000,
        method: jw > dice && jw > metaBoost ? "jaro-winkler"
              : dice > metaBoost ? "dice"
              : metaBoost > 0 ? "metaphone"
              : "hybrid",
      };
    }
  }

  return best.score >= threshold ? best : null;
}

/**
 * Find all candidates above the threshold, sorted by score descending.
 */
export function findAllMatches(
  query: string,
  candidates: string[],
  threshold = 0.88
): MatchResult[] {
  const results: MatchResult[] = [];

  for (const c of candidates) {
    const score = fuzzyScore(query, c, threshold);
    if (score > 0) {
      results.push({ match: c, score, method: "hybrid" });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
