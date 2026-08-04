#!/usr/bin/env node
/**
 * 復習メルマガ送信本体。
 * GitHub Actions から実行される（ローカルPCの電源とは無関係）。
 *
 * env:
 *   RESEND_API_KEY  必須。Resend の API キー
 *   MAIL_TO         必須。宛先
 *   MAIL_FROM       省略可。既定は Resend の共有ドメイン
 *   FORCE_SEND=1    復習期限が来ていなくても一番期限が近い1件を送る（テスト用）
 *   DRY_RUN=1       送信せず本文を標準出力に出す
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = path.join(ROOT, "notes");
const STATE_FILE = path.join(ROOT, "state.json");
const CHARACTER_FILE = path.join(ROOT, "character.json");

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 20_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 復習ステージの進行と、次回までの日数。 */
const STAGES = [
  { name: "新規", nextIn: 7 },
  { name: "1周目", nextIn: 14 },
  { name: "2周目", nextIn: 30 },
  { name: "3周目", nextIn: 60 },
  { name: "定着", nextIn: 120 },
];

const todayJst = () => new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);

const addDaysJst = (days) =>
  new Date(Date.now() + JST_OFFSET_MS + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

async function loadNotes() {
  const files = (await readdir(NOTES_DIR)).filter((f) => f.endsWith(".json"));
  const notes = [];
  for (const file of files) {
    const raw = await readFile(path.join(NOTES_DIR, file), "utf8");
    notes.push({ ...JSON.parse(raw), _file: file });
  }
  return notes;
}

/** 復習期限が古い順、同着なら学習日が古い順。 */
const byPriority = (a, b) =>
  String(a.nextReviewDate).localeCompare(String(b.nextReviewDate)) ||
  String(a.date).localeCompare(String(b.date));

function selectNote(notes, { force }) {
  const today = todayJst();
  const alive = notes.filter((n) => n.status !== "完了");
  const due = alive.filter((n) => String(n.nextReviewDate) <= today).sort(byPriority);
  if (due.length > 0) return due[0];
  if (force) return [...alive].sort(byPriority)[0] ?? null;
  return null;
}

/**
 * ノートに質問が書かれていなければ、見出しから素朴な質問を組み立てる。
 * 事前生成された questions があるときは常にそちらを使う。
 */
function questionsFor(note) {
  if (Array.isArray(note.questions) && note.questions.length > 0) {
    return note.questions.slice(0, 3);
  }
  const headings = String(note.content ?? "")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.replace(/^##\s*\d*[.．]?\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return headings.map((h) => ({
    q: `「${h}」のところ、読んでもピンと来なくて…。これって結局どういうことですか？`,
  }));
}

function renderHtml({ note, character, questions }) {
  const items = questions
    .map(
      (item, i) => `
      <tr><td style="padding:0 0 18px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#ffffff;border:1px solid #e6e1d8;border-radius:12px;">
          <tr><td style="padding:18px 20px;">
            <div style="font-size:12px;color:#9a8f7d;letter-spacing:.08em;margin-bottom:8px;">
              QUESTION ${i + 1}
            </div>
            <div style="font-size:16px;line-height:1.75;color:#2f2a22;font-weight:600;">
              ${escapeHtml(item.q)}
            </div>
            ${
              item.hint
                ? `<div style="font-size:13px;line-height:1.7;color:#7d7365;margin-top:10px;">
                     ${escapeHtml(item.hint)}
                   </div>`
                : ""
            }
          </td></tr>
        </table>
      </td></tr>`,
    )
    .join("");

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
       style="background:#faf7f1;margin:0;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic',sans-serif;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;">

      <tr><td style="padding:0 0 20px 0;">
        <div style="font-size:12px;color:#9a8f7d;letter-spacing:.1em;">復習メルマガ</div>
        <div style="font-size:13px;color:#7d7365;margin-top:6px;">
          ${escapeHtml(character.name)}から質問が届いています
        </div>
      </td></tr>

      <tr><td style="padding:0 0 22px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#3f7d4e;border-radius:12px;">
          <tr><td style="padding:22px 20px;">
            <div style="font-size:11px;color:#cfe6d4;letter-spacing:.1em;margin-bottom:8px;">
              ${escapeHtml(note.date)} ・ ${escapeHtml(note.source ?? "")}
            </div>
            <div style="font-size:19px;line-height:1.55;color:#ffffff;font-weight:700;">
              ${escapeHtml(note.title)}
            </div>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 0 22px 0;">
        <div style="font-size:15px;line-height:1.85;color:#4a4237;background:#fffdf8;
                    border-left:3px solid #3f7d4e;padding:14px 16px;border-radius:0 8px 8px 0;">
          ${escapeHtml(character.greeting)}
        </div>
      </td></tr>

      ${items}

      <tr><td style="padding:8px 0 0 0;">
        <div style="font-size:13px;line-height:1.8;color:#7d7365;">
          ${escapeHtml(character.closing)}
        </div>
      </td></tr>

      <tr><td style="padding:26px 0 0 0;border-top:1px solid #e6e1d8;margin-top:20px;">
        <div style="font-size:11px;line-height:1.7;color:#a99e8c;">
          復習ステージ: ${escapeHtml(note.reviewStage ?? "新規")} ／ 次回: 送信後に自動で先送りされます<br>
          note id: ${escapeHtml(note.id)}
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>`;
}

function renderText({ note, character, questions }) {
  const lines = [
    `【復習メルマガ】${character.name}から質問が届いています`,
    "",
    `${note.date} / ${note.source ?? ""}`,
    note.title,
    "",
    character.greeting,
    "",
    ...questions.flatMap((item, i) => [
      `Q${i + 1}. ${item.q}`,
      ...(item.hint ? [`    (${item.hint})`] : []),
      "",
    ]),
    character.closing,
    "",
    `note id: ${note.id}`,
  ];
  return lines.join("\n");
}

async function sendMail({ apiKey, from, to, subject, html, text }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Resend ${response.status}: ${body}`);
    }
    return JSON.parse(body);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Resend への送信が ${REQUEST_TIMEOUT_MS}ms でタイムアウトしました`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function advance(note) {
  const index = STAGES.findIndex((s) => s.name === (note.reviewStage ?? "新規"));
  const current = index === -1 ? STAGES[0] : STAGES[index];
  const next = STAGES[Math.min((index === -1 ? 0 : index) + 1, STAGES.length - 1)];
  return {
    reviewStage: next.name,
    nextReviewDate: addDaysJst(current.nextIn),
    status: "出題済み",
    lastSentDate: todayJst(),
  };
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { history: [] };
    throw error;
  }
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM || "onboarding@example.com";
  const force = process.env.FORCE_SEND === "1";
  const dryRun = process.env.DRY_RUN === "1";

  if (!dryRun && (!apiKey || !to)) {
    throw new Error("RESEND_API_KEY と MAIL_TO が必要です");
  }

  const character = JSON.parse(await readFile(CHARACTER_FILE, "utf8"));
  const notes = await loadNotes();
  const note = selectNote(notes, { force });

  if (!note) {
    console.log(`今日(${todayJst()})は復習期限のノートがありません。送信をスキップします。`);
    return;
  }

  const questions = questionsFor(note);
  const html = renderHtml({ note, character, questions });
  const text = renderText({ note, character, questions });
  // 件名は開封のフック。note.mailHook があればそれを、無ければタイトルを使う。
  const subject = `${character.name}から質問です —「${note.mailHook ?? note.title}」`;

  if (dryRun) {
    console.log(`--- DRY RUN ---\nto: ${to ?? "(未設定)"}\nsubject: ${subject}\n\n${text}`);
    return;
  }

  const result = await sendMail({ apiKey, from, to, subject, html, text });
  console.log(`送信しました: ${note.id} (resend id: ${result.id})`);

  const patch = advance(note);
  const { _file, ...rest } = note;
  await writeFile(
    path.join(NOTES_DIR, _file),
    `${JSON.stringify({ ...rest, ...patch }, null, 2)}\n`,
    "utf8",
  );

  const state = await readState();
  state.history.unshift({
    sentAt: new Date().toISOString(),
    dateJst: todayJst(),
    noteId: note.id,
    subject,
    resendId: result.id,
  });
  state.history = state.history.slice(0, 200);
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(`送信に失敗しました: ${error.message}`);
  process.exit(1);
});
