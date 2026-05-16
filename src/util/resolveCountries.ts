export interface Country {
  id: number;
  name: string;
}

export interface ResolveResult {
  ids: number[];
  unknown: string[];
  suggestions: Record<string, string>;
}

/**
 * Resolves a comma-separated list of country names or IDs against the catalog.
 * Name matching is case-insensitive. Unknown tokens get a fuzzy suggestion
 * when a catalog entry is within Levenshtein distance 2.
 */
export function resolveCountries(input: string, catalog: Country[]): ResolveResult {
  const tokens = input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const byId = new Map(catalog.map((c) => [c.id, c]));
  const byName = new Map(catalog.map((c) => [c.name.toLowerCase(), c]));

  const ids: number[] = [];
  const seen = new Set<number>();
  const unknown: string[] = [];
  const suggestions: Record<string, string> = {};

  for (const token of tokens) {
    const numeric = /^\d+$/.test(token) ? Number(token) : null;
    if (numeric !== null) {
      if (byId.has(numeric)) {
        if (!seen.has(numeric)) {
          ids.push(numeric);
          seen.add(numeric);
        }
      } else {
        unknown.push(token);
      }
      continue;
    }

    const named = byName.get(token.toLowerCase());
    if (named) {
      if (!seen.has(named.id)) {
        ids.push(named.id);
        seen.add(named.id);
      }
      continue;
    }

    unknown.push(token);
    const suggestion = closestName(token, catalog);
    if (suggestion) {
      suggestions[token] = suggestion;
    }
  }

  return { ids, unknown, suggestions };
}

function closestName(token: string, catalog: Country[]): string | null {
  let best: { name: string; distance: number } | null = null;
  const lower = token.toLowerCase();

  for (const c of catalog) {
    const d = levenshtein(lower, c.name.toLowerCase());
    if (d <= 2 && (best === null || d < best.distance)) {
      best = { name: c.name, distance: d };
    }
  }

  return best?.name ?? null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const curr = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return curr[b.length];
}
