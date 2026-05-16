import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCountries, type Country } from './resolveCountries.js';

// Resolve countries.json relative to this script's own location so it works
// in both dev (src/util/ → ../../data) and in the Windows ZIP layout
// (app/dist/util/ → ../../data → app/data). Does NOT depend on ERP_ROOT,
// which is not set during setup.bat's blocked-countries prompt.
const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, '..', '..', 'data', 'countries.json');

const args = process.argv.slice(2);
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Country[];

if (args[0] === '--list') {
  // Print the catalog in three columns sorted by name, with IDs aligned.
  const rows = [...catalog]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${String(c.id).padStart(3, ' ')}  ${c.name}`);

  const COLS = 3;
  const colHeight = Math.ceil(rows.length / COLS);
  const cells: string[][] = [];
  for (let r = 0; r < colHeight; r++) {
    const row: string[] = [];
    for (let c = 0; c < COLS; c++) {
      const idx = c * colHeight + r;
      row.push((rows[idx] ?? '').padEnd(28, ' '));
    }
    cells.push(row);
  }
  for (const row of cells) console.log(row.join(''));
  process.exit(0);
}

const input = args.join(' ');
const result = resolveCountries(input, catalog);

if (result.unknown.length > 0) {
  console.error('Unrecognized country tokens:');
  for (const token of result.unknown) {
    const suggestion = result.suggestions[token];
    console.error(suggestion ? `  - "${token}" — did you mean "${suggestion}"?` : `  - "${token}"`);
  }
  process.exit(1);
}

// Success: print CSV of resolved IDs (or empty line if nothing was provided).
process.stdout.write(result.ids.join(','));
