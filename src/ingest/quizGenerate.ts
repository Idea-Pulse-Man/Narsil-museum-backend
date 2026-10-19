/**
 * Quiz question engine cron.
 * ---------------------------------------------------------------------------
 * Generates new questions for every style the admin switched on (quiz_styles),
 * saves them to quiz_items, then tops up today's daily edition
 * (daily_quiz_items). Old app versions keep using `quiz:daily`.
 *
 * Usage:
 *   npm run quiz:generate
 *   npm run quiz:generate -- --dry-run                 # build + print, write nothing
 *   npm run quiz:generate -- --style=pick_image,year_slider --count=5
 *   npm run quiz:generate -- --no-daily                # skip the daily top-up
 *   npm run quiz:generate -- --date=2026-10-20         # daily edition for that UTC day
 *
 * Cron: see INGEST.md. Run museum-app/supabase/quiz-engine.sql once first.
 */
import "dotenv/config";
import { runGeneration } from "../quiz/generate.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const dryRun = args.includes("--dry-run");
const styles = flag("style")?.split(",").map((s) => s.trim()).filter(Boolean);
const count = Number(flag("count"));
const date = flag("date");

if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`Bad --date value: ${date}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const summary = await runGeneration({
    trigger: "cron",
    styleIds: styles,
    count: Number.isFinite(count) && count > 0 ? count : undefined,
    fillDaily: !args.includes("--no-daily"),
    date,
    dryRun,
    log: (line) => console.log(line),
  });
  for (const problem of summary.problems) console.warn(`  ! ${problem}`);
  if (dryRun) {
    for (const item of summary.samples) {
      console.log(`  [${item.style}] ${item.prompt}`);
    }
  }
  const total = Object.values(summary.created).reduce((a, b) => a + b, 0);
  console.log(`${dryRun ? "dry-run: built" : "saved"} ${total} question(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
