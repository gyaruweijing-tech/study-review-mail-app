#!/usr/bin/env node
/**
 * ローカルの MulmoClaude ワークスペースから学習ノートを取り込む。
 * PCが起動しているときに手で叩く（週1回動けば足りる）。
 *
 * 同期の向きと責務（2026-08-07 に questions/mailHook の持ち主を反転した）:
 *   - 「教材と、教材から作れるもの」は MulmoClaude 側が正。
 *     title/date/source/tags/summary/content に加えて questions/mailHook もこちら。
 *     ノートは本文を MulmoClaude のチャットに貼って作るので、取り込みの瞬間に本文は読まれている。
 *     質問もそこで一緒に作らせるのが一番安い（後から API で読み直させるのは二度払い）。
 *   - 「誰がいつ何と答えたか」はこのリポジトリが正。GitHub Actions が書き換えるので上書きしない。
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOTES_DIR = path.join(ROOT, "notes");
const SOURCE_DIR =
  process.env.STUDY_REVIEW_SRC ??
  path.join(os.homedir(), "mulmoclaude", "data", "study-review", "items");

/** リポジトリ側が保持し、同期で上書きされないフィールド。answers は回答履歴。 */
const REPO_OWNED = ["reviewStage", "nextReviewDate", "status", "lastSentDate", "answers"];

/**
 * MulmoClaude 側が正だが、空で既存を潰してはいけないフィールド。
 * 向こうがまだ questions を持っていないノートが1本混ざるだけで良問が消えるため、
 * 「中身があるときだけ受け取る」を機械的に守る。
 */
const INCOMING_IF_PRESENT = {
  questions: (v) => Array.isArray(v) && v.length > 0,
  mailHook: (v) => typeof v === "string" && v.trim() !== "",
};

/**
 * MulmoClaude 側の復習ステージ（新規/1回目/…/マスター）は、
 * このリポジトリのステージ（新規/1周目/…/定着）とは別物の進行状態。
 * 語彙が違うので持ち込むと answer.mjs の STAGES.indexOf が -1 になり無言で「新規」に落ちる。
 * 新規取り込みは必ずこちらの初期値から始める。
 */
const INITIAL_STATE = {
  reviewStage: "新規",
  status: "未復習",
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const todayJst = () => new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  await mkdir(NOTES_DIR, { recursive: true });

  let files;
  try {
    files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith(".json"));
  } catch (error) {
    throw new Error(`取り込み元が読めません: ${SOURCE_DIR} (${error.message})`);
  }

  let added = 0;
  let updated = 0;

  for (const file of files) {
    const incoming = JSON.parse(await readFile(path.join(SOURCE_DIR, file), "utf8"));
    const destPath = path.join(NOTES_DIR, file);
    const existing = await readJsonIfExists(destPath);

    const merged = { ...incoming };
    if (existing) {
      for (const key of REPO_OWNED) {
        if (existing[key] !== undefined) merged[key] = existing[key];
      }
      // 向こうが空/未対応なら、こちらの既存を残す（無言で良問を消さないための番人）
      for (const [key, hasValue] of Object.entries(INCOMING_IF_PRESENT)) {
        if (!hasValue(incoming[key])) merged[key] = existing[key];
      }
    } else {
      // 新規取り込み。MulmoClaude 側の進行状態は語彙が別物なので持ち込まない。
      Object.assign(merged, INITIAL_STATE);
      // 期限は学習日に置く。すぐ出題対象になり、古いノートから順に届く。
      merged.nextReviewDate = incoming.date ?? todayJst();
    }
    for (const key of Object.keys(INCOMING_IF_PRESENT)) {
      if (merged[key] === undefined) delete merged[key];
    }

    const next = `${JSON.stringify(merged, null, 2)}\n`;
    const prev = existing ? `${JSON.stringify(existing, null, 2)}\n` : null;
    if (next === prev) continue;

    await writeFile(destPath, next, "utf8");
    if (existing) updated += 1;
    else added += 1;
  }

  console.log(`同期完了: 新規 ${added} 件 / 更新 ${updated} 件 (元: ${SOURCE_DIR})`);
  if (added + updated > 0) {
    console.log("この後 git add . && git commit && git push で GitHub に反映してください。");
  }
}

main().catch((error) => {
  console.error(`同期に失敗しました: ${error.message}`);
  process.exit(1);
});
