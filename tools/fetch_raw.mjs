// Download the raw recall records the build uses. Both APIs are public and need no key.
// Usage: node fetch_raw.mjs <out_dir> [fda_from=20200101] [cpsc_from=2018-01-01]
// Writes fda_food_enforcement_<year>.json (openFDA food enforcement reports by report_date) and
// cpsc_recalls_<year>.json (CPSC Recalls API by recall date).
import fs from 'node:fs/promises';
import path from 'node:path';

const [outDir, fdaFrom = '20200101', cpscFrom = '2018-01-01'] = process.argv.slice(2);
await fs.mkdir(outDir, { recursive: true });

// openFDA returns at most 1000 records per call and refuses skip beyond 25,000, so page by year.
const fda = [];
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
for (let y = Number(fdaFrom.slice(0, 4)); y <= Number(today.slice(0, 4)); y++) {
  const from = y === Number(fdaFrom.slice(0, 4)) ? fdaFrom : `${y}0101`;
  for (let skip = 0; ; skip += 1000) {
    const url = `https://api.fda.gov/food/enforcement.json?search=report_date:[${from}+TO+${y}1231]&limit=1000&skip=${skip}`;
    const res = await fetch(url);
    if (res.status === 404) break; // no (more) matches
    if (!res.ok) throw new Error(`openFDA ${res.status} for ${url}`);
    const { results } = await res.json();
    fda.push(...results);
    if (results.length < 1000) break;
  }
  console.log(`FDA ${y}: total so far ${fda.length}`);
}
await fs.writeFile(path.join(outDir, `fda_food_enforcement_${fdaFrom.slice(0, 4)}.json`), JSON.stringify(fda));

const res = await fetch(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${cpscFrom}`);
if (!res.ok) throw new Error(`CPSC ${res.status}`);
const cpsc = await res.json();
await fs.writeFile(path.join(outDir, `cpsc_recalls_${cpscFrom.slice(0, 4)}.json`), JSON.stringify(cpsc));
console.log(`FDA reports ${fda.length}, CPSC recalls ${cpsc.length}`);
