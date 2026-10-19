// SequenceMatcher(None, a, b).ratio() from CPython's difflib, ported faithfully
// (including the autojunk "popular element" rule for b of 200+ items) so fuzzy
// match scores are identical to the Python server's.

export function sequenceRatio(aText: string, bText: string): number {
  const a = Array.from(aText);
  const b = Array.from(bText);
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchingCharacters(a, b)) / total;
}

function matchingCharacters(a: string[], b: string[]): number {
  const b2j = new Map<string, number[]>();
  b.forEach((elt, i) => {
    const list = b2j.get(elt);
    if (list) list.push(i);
    else b2j.set(elt, [i]);
  });
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
  }

  const findLongestMatch = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // No junk function, so the junk-extension passes reduce to these two.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };

  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (!k) continue;
    matches += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return matches;
}
