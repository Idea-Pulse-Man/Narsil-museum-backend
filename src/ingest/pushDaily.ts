/**
 * Daily quiz notifications.
 * ---------------------------------------------------------------------------
 *   --quiz    "Today's Royal Assessment is ready" — to people who have played
 *             before and haven't played today. Morning (US).
 *   --streak  "Your N-day streak ends tonight" — to people whose streak is
 *             alive and who haven't played today. Evening (US).
 *
 * Only accounts with a quiz_progress row are notified: people who never
 * played don't get daily nudges. Quiz days are UTC, like the daily quiz.
 *
 * Usage:
 *   npm run push:daily -- --quiz
 *   npm run push:daily -- --streak
 *   npm run push:daily -- --quiz --dry-run
 *
 * Cron: see INGEST.md. Needs APNS_* in .env and supabase/push-notifications.sql.
 */
import "dotenv/config";
import { supabaseAdmin } from "../services/supabaseAdmin.js";
import { pushConfigured, sendToTokens, type PushMessage } from "../services/push.js";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const MODE = args.has("--streak") ? "streak" : args.has("--quiz") ? "quiz" : null;

interface ProgressRow {
  user_id: string;
  streak: number;
  last_played_date: string | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function allProgress(): Promise<ProgressRow[]> {
  const db = supabaseAdmin();
  const out: ProgressRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("quiz_progress")
      .select("user_id, streak, last_played_date")
      .range(from, from + 999);
    if (error) throw new Error(`quiz_progress: ${error.message}`);
    out.push(...((data ?? []) as ProgressRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function tokensByUser(userIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < userIds.length; i += 200) {
    const { data, error } = await supabaseAdmin()
      .from("push_tokens")
      .select("token, user_id")
      .in("user_id", userIds.slice(i, i + 200));
    if (error) throw new Error(`push_tokens: ${error.message}`);
    for (const row of (data ?? []) as { token: string; user_id: string }[]) {
      map.set(row.user_id, [...(map.get(row.user_id) ?? []), row.token]);
    }
  }
  return map;
}

async function main(): Promise<void> {
  if (!MODE) {
    console.error("Pass --quiz or --streak.");
    process.exit(1);
  }
  if (!pushConfigured() && !DRY_RUN) {
    console.log("Push skipped — APNS_KEY / APNS_KEY_ID / APPLE_TEAM_ID not set.");
    return;
  }

  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));

  if (MODE === "quiz") {
    const { data: quiz } = await supabaseAdmin()
      .from("daily_quizzes")
      .select("quiz_date")
      .eq("quiz_date", today)
      .maybeSingle();
    if (!quiz) {
      console.log(`No daily quiz for ${today} yet — nothing sent.`);
      return;
    }
  }

  const progress = (await allProgress()).filter((p) => p.last_played_date !== today);
  const targets =
    MODE === "streak"
      ? progress.filter((p) => p.streak > 0 && p.last_played_date === yesterday)
      : progress;

  const tokens = await tokensByUser(targets.map((t) => t.user_id));
  console.log(`${MODE}: ${targets.length} players, ${tokens.size} with notifications on.`);
  if (DRY_RUN) return;

  let sent = 0;
  if (MODE === "quiz") {
    const message: PushMessage = {
      title: "Today's Royal Assessment is ready",
      body: "Ten new questions are waiting in the Hall.",
      data: { type: "quiz" },
    };
    sent = await sendToTokens([...tokens.values()].flat(), message);
  } else {
    // Personalised by streak length, so one send per player.
    for (const t of targets) {
      const userTokens = tokens.get(t.user_id);
      if (!userTokens) continue;
      sent += await sendToTokens(userTokens, {
        title: `Your ${t.streak}-day streak ends tonight`,
        body: "Answer today's Royal Assessment to keep it going.",
        data: { type: "quiz" },
      });
    }
  }
  console.log(`Sent ${sent} notifications.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("push:daily failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
