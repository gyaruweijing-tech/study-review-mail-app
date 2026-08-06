/**
 * Issue で返ってきた回答を受け取り、復習ステージに反映する。
 *
 * セキュリティ上の前提（ワークフロー側と対で守ること）:
 *   - Issue本文は「信頼できない入力」として扱う。run: に直接展開させず、必ず env 経由で受け取る
 *   - このスクリプトに RESEND_API_KEY 等の秘密は渡さない。ここは state と notes しか触らない
 *   - 実行はリポジトリ所有者が立てた Issue のみ（ワークフロー側の if で担保）
 *
 * 環境変数:
 *   ISSUE_TITLE / ISSUE_BODY / ISSUE_NUMBER / ISSUE_LABELS  Issueの中身（env経由で受け取る）
 *   DRY_RUN                                                 1 なら書き込まず結果だけ出す
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, "state.json");
const NOTES_DIR = path.join(ROOT, "notes");

// 復習ステージの進行表はここが正。ステージを動かすのは回答が届いたときだけなので、
// 送信側（send.mjs）はこの表を持たない
const STAGES = ["新規", "1周目", "2周目", "3周目", "定着"];
const STAGE_DAYS = { 新規: 7, "1周目": 14, "2周目": 30, "3周目": 60, 定着: 120 };

// 自己申告の3段階。将来 grade.mjs の judge() に置き換わる想定で、
// 「どう判定したか」ではなく「判定結果」だけをここで扱う
const LEVELS = {
  ok: { label: "余裕でした", move: +1, minDays: null },
  vague: { label: "あやしい", move: 0, minDays: 7 },
  ng: { label: "無理でした", move: -1, minDays: 3 },
};

/**
 * 処理結果を呼び出し元（ワークフロー）に返す。
 * 記録できなかったのに「受け取りました」と返してIssueを閉じると、
 * 本人は記録された気になるが実際には何も残っていない、という最悪の嘘になる。
 * だから成否を必ず伝え、失敗時はIssueを開いたままにする。
 */
function report(ok, message) {
  console.log(message);
  if (process.env.COMMENT_FILE) {
    writeFileSync(process.env.COMMENT_FILE, message, "utf8");
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `recorded=${ok}\n`, "utf8");
  }
}

function addDaysJst(days) {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + days);
  return jst.toISOString().slice(0, 10);
}

/** Issueのタイトル/本文/ラベルから noteId と level を拾う。見つからなければ null */
function parseIssue({ title, body, labels }) {
  const text = `${title}\n${body}`;

  // 本文に埋め込んだマーカー行を最優先で読む（人間が書き足しても壊れない）
  const noteId =
    text.match(/^\s*noteId:\s*([A-Za-z0-9._-]+)\s*$/m)?.[1] ??
    title.match(/\[回答\]\s*([A-Za-z0-9._-]+)/)?.[1] ??
    null;

  const fromLabel = labels.map((l) => l.match(/^level:(ok|vague|ng)$/)?.[1]).find(Boolean);
  const level = fromLabel ?? text.match(/^\s*level:\s*(ok|vague|ng)\s*$/m)?.[1] ?? null;

  return { noteId, level };
}

/** マーカー行を除いた、本人が書いた説明の部分だけを取り出す */
function extractExplanation(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*(noteId|level):\s*\S+\s*$/.test(line))
    .join("\n")
    .trim();
}

function loadNote(noteId) {
  // ディレクトリ走査で実在するファイルだけを対象にする。
  // env 由来の文字列をそのままパスに連結しない（パストラバーサル対策）
  const file = readdirSync(NOTES_DIR).find((f) => f === `${noteId}.json`);
  if (!file) return null;
  const full = path.join(NOTES_DIR, file);
  return { full, note: JSON.parse(readFileSync(full, "utf8")) };
}

function nextSchedule(note, level) {
  const rule = LEVELS[level];
  const current = note.reviewStage ?? "新規";
  const index = Math.max(0, STAGES.indexOf(current));
  const moved = Math.min(STAGES.length - 1, Math.max(0, index + rule.move));
  const stage = STAGES[moved];

  let days = STAGE_DAYS[stage];
  if (rule.minDays !== null) days = Math.min(days, rule.minDays);

  return { stage, nextReviewDate: addDaysJst(days), days };
}

function main() {
  const title = process.env.ISSUE_TITLE ?? "";
  const body = process.env.ISSUE_BODY ?? "";
  const number = process.env.ISSUE_NUMBER ?? "";
  const labels = (process.env.ISSUE_LABELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = process.env.DRY_RUN === "1";

  const { noteId, level } = parseIssue({ title, body, labels });
  if (!noteId || !level) {
    report(
      false,
      `⚠️ 回答として読み取れませんでした（noteId=${noteId ?? "不明"} / level=${level ?? "不明"}）。\n` +
        "本文の `noteId:` と `level:` の行が消えていないか確認してください。" +
        "**このIssueは開いたままにしてあります**。復習予定には何も反映していません。",
    );
    return;
  }

  const found = loadNote(noteId);
  if (!found) {
    report(
      false,
      `⚠️ ノートが見つかりませんでした: \`${noteId}\`\n` +
        "**このIssueは開いたままにしてあります**。復習予定には何も反映していません。",
    );
    return;
  }

  const { full, note } = found;
  const before = note.reviewStage ?? "新規";
  const { stage, nextReviewDate, days } = nextSchedule(note, level);

  note.reviewStage = stage;
  note.nextReviewDate = nextReviewDate;
  note.status = "回答済み";
  note.awaitingAnswer = false;

  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  state.answers = state.answers ?? [];
  state.answers.unshift({
    answeredAt: new Date().toISOString(),
    noteId,
    level,
    judgedBy: "self", // 将来AI判定を入れたら "ai" になる。遡って再判定できるよう残す
    issueNumber: Number(number) || null,
    explanation: extractExplanation(body).slice(0, 4000),
    stageBefore: before,
    stageAfter: stage,
  });
  state.answers = state.answers.slice(0, 500);

  if (dryRun) {
    console.log(
      `[DRY_RUN] ${noteId}: ${LEVELS[level].label} → ${before} → ${stage} / 次回 ${nextReviewDate} (${days}日後)`,
    );
    return;
  }

  writeFileSync(full, `${JSON.stringify(note, null, 2)}\n`);
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

  report(
    true,
    `**${LEVELS[level].label}** で記録しました。\n\n` +
      `- 復習ステージ: ${before} → **${stage}**\n` +
      `- 次回: **${nextReviewDate}**（${days}日後）`,
  );
}

main();
