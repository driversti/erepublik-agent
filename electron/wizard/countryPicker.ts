export interface Country { id: number; name: string; }

const MAX_SUGGESTIONS = 8;

export function suggestCountries(query: string, catalog: Country[]): Country[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix = catalog.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix.slice(0, MAX_SUGGESTIONS);
  const substring = catalog.filter((c) => c.name.toLowerCase().includes(q));
  return substring.slice(0, MAX_SUGGESTIONS);
}

export interface ParseResult {
  chips: Country[];
  unknown: string[];
}

export function parseChips(input: string, catalog: Country[]): ParseResult {
  const chips: Country[] = [];
  const unknown: string[] = [];
  for (const raw of input.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const asNum = Number.parseInt(t, 10);
    if (!Number.isNaN(asNum) && String(asNum) === t) {
      const c = catalog.find((x) => x.id === asNum);
      if (c) chips.push(c);
      else unknown.push(t);
      continue;
    }
    const c = catalog.find((x) => x.name.toLowerCase() === t.toLowerCase());
    if (c) chips.push(c);
    else unknown.push(t);
  }
  return { chips, unknown };
}
