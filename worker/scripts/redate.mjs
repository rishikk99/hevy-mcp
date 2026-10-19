// Recompute every stored workout's local start/end time and date in D1, with
// the same parseTimestamp the Worker uses (bundled from src/).
//
//   node scripts/redate.mjs
//
// Run it after changing TIMEZONE in src/config.ts, once the new code is
// deployed. Safe to re-run: it only rewrites the three date columns, from the
// raw payloads. Needs CLOUDFLARE_API_TOKEN.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "hevy-redate-"));

const wrangler = (args) =>
  execFileSync("npx", ["wrangler", ...args], { cwd: workerDir, shell: true, encoding: "utf8", maxBuffer: 64 << 20 });

try {
  const bundle = join(work, "time.mjs");
  await build({
    stdin: {
      contents: 'export { parseTimestamp } from "./src/normalize"; export { TIMEZONE } from "./src/config";',
      resolveDir: workerDir,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: bundle,
    logLevel: "error",
  });
  const { parseTimestamp, TIMEZONE } = await import(pathToFileURL(bundle).href);

  const query =
    "SELECT workout_id, json_extract(payload, '$.start_time') AS s, json_extract(payload, '$.end_time') AS e " +
    "FROM raw_workouts";
  const out = wrangler(["d1", "execute", "hevy", "--remote", "--json", "--command", JSON.stringify(query)]);
  const rows = JSON.parse(out)[0].results;

  const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const lines = rows.map(({ workout_id, s, e }) => {
    const [startTime, startDate] = parseTimestamp(s);
    const [endTime] = parseTimestamp(e);
    return (
      `UPDATE workout SET start_time = ${q(startTime)}, end_time = ${q(endTime)}, start_date = ${q(startDate)} ` +
      `WHERE workout_id = ${q(workout_id)};`
    );
  });
  // Sets carry their workout's date, denormalized for the date indexes.
  lines.push(
    "UPDATE workout_set SET start_date = COALESCE((SELECT w.start_date FROM workout w " +
      "WHERE w.workout_id = workout_set.workout_id), start_date);",
  );

  const sqlFile = join(work, "redate.sql");
  writeFileSync(sqlFile, lines.join("\n") + "\n");
  wrangler(["d1", "execute", "hevy", "--remote", "--yes", "--file", JSON.stringify(sqlFile)]);
  console.log(`Re-dated ${rows.length} workouts in ${TIMEZONE}.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
