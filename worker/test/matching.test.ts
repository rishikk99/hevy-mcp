// Ported from tests/test_matching.py, plus pyjson's Python-compatibility helpers.

import { describe, expect, it } from "vitest";

import { sequenceRatio } from "../src/difflib";
import { bestMatch, findMatches } from "../src/matching";
import { normalizeName, parseTimestamp } from "../src/normalize";
import { pyRound, pythonJsonDumpsSorted } from "../src/pyjson";

const NAMES = [
  "Bench Press (Barbell)",
  "Bench Press (Dumbbell)",
  "Incline Bench Press (Barbell)",
  "Squat (Barbell)",
  "Bulgarian Split Squat",
  "Romanian Deadlift (Barbell)",
  "Deadlift (Barbell)",
  "Lat Pulldown (Cable)",
  "Seated Row (Cable)",
  "Overhead Press (Barbell)",
];

describe("fuzzy matching", () => {
  it.each([
    ["Bench Press (Barbell)", "Bench Press (Barbell)"],
    ["bench press barbell", "Bench Press (Barbell)"],
    ["BENCH PRESS (BARBELL)", "Bench Press (Barbell)"],
    ["squat", "Squat (Barbell)"],
    ["lat pulldown", "Lat Pulldown (Cable)"],
    ["incline bench", "Incline Bench Press (Barbell)"],
    ["deadlift barbel", "Deadlift (Barbell)"],
    ["romanian deadlift", "Romanian Deadlift (Barbell)"],
    ["seated row", "Seated Row (Cable)"],
    ["bench pres barbell", "Bench Press (Barbell)"],
  ])("%s -> %s", (query, expected) => {
    expect(bestMatch(query, NAMES)[0]?.name).toBe(expected);
  });

  it("scores an exact match 1.0", () => {
    const [match] = bestMatch("Squat (Barbell)", NAMES);
    expect(match).toMatchObject({ score: 1, how: "exact" });
  });

  it("prefers the tersest candidate containing all terms, and shows the rest", () => {
    const [match, alternatives] = bestMatch("bench press", NAMES);
    expect(match?.name).toBe("Bench Press (Barbell)");
    expect(alternatives.map((m) => m.name)).toContain("Incline Bench Press (Barbell)");
  });

  it.each(["kayaking", "", "rdl barbell", "ohp barbell", "bss", "kayak barbell"])(
    "returns no match rather than a wrong one for %j",
    (query) => {
      expect(bestMatch(query, NAMES)).toEqual([null, []]);
    },
  );

  it("handles no candidates, limits, and thresholds", () => {
    expect(bestMatch("squat", [])[0]).toBeNull();
    expect(findMatches("bench", NAMES, 0.6, 2)).toHaveLength(2);
    expect(findMatches("benc", NAMES, 0.99)).toEqual([]);
  });

  it.each([
    ["Bench Press (Barbell)", "bench press barbell"],
    ["  Squat   (Barbell) ", "squat barbell"],
    ["Push-Up", "push up"],
    ["", ""],
  ])("normalizes %j", (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  // Values from CPython's difflib.SequenceMatcher(None, a, b).ratio().
  it.each([
    ["bench pres barbell", "bench press barbell", 0.972972972972973],
    ["abcd", "bcde", 0.75],
    ["deadlift", "deadlift barbell", 0.6666666666666666],
    ["", "", 1],
  ])("difflib ratio(%j, %j)", (a, b, expected) => {
    expect(sequenceRatio(a, b)).toBe(expected);
  });
});

describe("local time", () => {
  // Same cases as tests/test_normalize.py, so both servers agree.
  it.each([
    [1788830888, ["2026-09-07T20:28:08-05:00", "2026-09-07"]], // 01:28 UTC is the evening before
    [1795656600, ["2026-11-25T19:30:00-06:00", "2026-11-25"]], // standard time: -6
    ["2026-09-08T01:28:08Z", ["2026-09-07T20:28:08-05:00", "2026-09-07"]],
    ["2026-09-07T22:28:08-03:00", ["2026-09-07T20:28:08-05:00", "2026-09-07"]],
    ["2026-08-20T17:30:00", ["2026-08-20T12:30:00-05:00", "2026-08-20"]], // naive means UTC
    [1787247000000, ["2026-08-20T12:30:00-05:00", "2026-08-20"]], // milliseconds
  ])("parseTimestamp(%j) in America/Chicago", (value, expected) => {
    expect(parseTimestamp(value)).toEqual(expected);
  });

  it("follows the zone it is given", () => {
    expect(parseTimestamp(1788830888, "UTC")).toEqual(["2026-09-08T01:28:08+00:00", "2026-09-08"]);
    expect(parseTimestamp(1788830888, "Asia/Kolkata")).toEqual(["2026-09-08T06:58:08+05:30", "2026-09-08"]);
  });

  it("rejects what is not a time", () => {
    expect(parseTimestamp(null)).toEqual([null, null]);
    expect(parseTimestamp("last tuesday")).toEqual(["last tuesday", null]);
  });
});

describe("Python compatibility", () => {
  it.each([
    [0.8125, 3, 0.812], // a true tie rounds to even
    [0.6875, 3, 0.688],
    [2.675, 2, 2.67], // 2.675 is really 2.67499999...
    [1234.55, 1, 1234.5],
    [0.5, 0, 0],
    [1.5, 0, 2],
    [-0.04, 1, 0],
    [42, 1, 42],
  ])("pyRound(%d, %d) = %d", (x, places, expected) => {
    expect(pyRound(x, places)).toBe(expected);
  });

  it("serializes like json.dumps(sort_keys=True, separators=(',', ':'))", () => {
    expect(
      pythonJsonDumpsSorted({ b: [1, 2.5, null, true], a: "Café ☕ \"q\"\n", c: 1e-7, d: 1e16 + 2, e: 0.1 }),
    ).toBe('{"a":"Caf\\u00e9 \\u2615 \\"q\\"\\n","b":[1,2.5,null,true],"c":1e-07,"d":1.0000000000000002e+16,"e":0.1}');
  });
});
