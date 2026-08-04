#!/usr/bin/env node
/**
 * ローカルの MulmoClaude ワークスペースから学習ノートを取り込む。
 * PCが起動しているときに手で叩く（週1回動けば足りる）。
 *
 * 同期の向きと責務:
 *   - 教材そのもの (title/date/source/tags/summary/content) は MulmoClaude 側が正。
 *   - 復習の進行状態 (reviewStage/nextReviewDate/status/lastSentDate) と questions は
 *     このリポジトリ側が正。GitHub Actions が書き換えるので、上書きしない。
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

/** リポジトリ側が保持し、同期で上書きされないフィールド。 */
const REPO_OWNED = ["reviewStage", "nextReviewDate", "status", "lastSentDate", "questions"];

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
