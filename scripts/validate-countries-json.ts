import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Country {
  id: number;
  name: string;
}

interface ApiResponse {
  countries: Record<string, { id: number; name: string }>;
}

const URL = 'https://www.erepublik.com/en/military/campaignsJson/list';
const COMMITTED_PATH = resolve('data/countries.json');

async function main(): Promise<void> {
  const response = await fetch(URL);
  if (!response.ok) {
    console.error(`Failed to fetch ${URL}: HTTP ${response.status}`);
    process.exit(2);
  }

  const body = (await response.json()) as ApiResponse;
  const live = Object.values(body.countries)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.id - b.id);

  const committed = JSON.parse(readFileSync(COMMITTED_PATH, 'utf8')) as Country[];

  const liveById = new Map(live.map((c) => [c.id, c.name]));
  const committedById = new Map(committed.map((c) => [c.id, c.name]));

  const added: Country[] = [];
  const removed: Country[] = [];
  const renamed: Array<{ id: number; before: string; after: string }> = [];

  for (const [id, name] of liveById) {
    if (!committedById.has(id)) {
      added.push({ id, name });
    } else if (committedById.get(id) !== name) {
      renamed.push({ id, before: committedById.get(id)!, after: name });
    }
  }

  for (const [id, name] of committedById) {
    if (!liveById.has(id)) {
      removed.push({ id, name });
    }
  }

  if (added.length === 0 && removed.length === 0 && renamed.length === 0) {
    console.log(`OK: ${live.length} countries match data/countries.json`);
    process.exit(0);
  }

  console.error('Country catalog drift detected:');
  if (added.length > 0) {
    console.error('  Added (in API, missing from committed file):');
    for (const c of added) console.error(`    + id=${c.id} ${c.name}`);
  }
  if (removed.length > 0) {
    console.error('  Removed (in committed file, missing from API):');
    for (const c of removed) console.error(`    - id=${c.id} ${c.name}`);
  }
  if (renamed.length > 0) {
    console.error('  Renamed:');
    for (const r of renamed) console.error(`    ~ id=${r.id} "${r.before}" -> "${r.after}"`);
  }
  console.error('');
  console.error('Update data/countries.json and review the diff before committing.');
  process.exit(1);
}

void main();
