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
const CHARACTERS_FILE = path.join(ROOT, "characters.json");
const CHARACTER_FILE = path.join(ROOT, "character.json"); // 旧・単一キャラ形式のフォールバック

const REPO = process.env.GITHUB_REPOSITORY || "gyaruweijing-tech/study-review-mail";

/** 未回答のまま放置されたノートを、もう一度出すまでの日数。ステージは進めない。 */
const RETRY_IN_DAYS = 7;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 20_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 復習ステージの進行表（新規→1周目→…）は answer.mjs が持つ。
// ステージを動かすのは回答が届いたときだけなので、送信側は表を知らなくてよい。

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

/**
 * キャラは順番に回す。同じ人が続くと「またこの人か」になるし、
 * 聞かれる角度が固定されると毎回同じ説明しか書かなくなる。
 */
async function loadCharacter(state) {
  try {
    const { characters, sharedRules } = JSON.parse(await readFile(CHARACTERS_FILE, "utf8"));
    const index = (state.history?.length ?? 0) % characters.length;
    return { ...characters[index], rules: sharedRules };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return JSON.parse(await readFile(CHARACTER_FILE, "utf8"));
  }
}

/**
 * 回答用の Issue 作成リンク。タイトルと本文を埋めた状態で開くので、押して送るだけで済む。
 * URL に載せるのは note.id と自己申告レベルだけ。ノート本文や質問文は載せない
 * （ブラウザ履歴に中身が残るため）。
 */
function answerUrl(note, level) {
  const params = new URLSearchParams({
    title: `[回答] ${note.id}`,
    body: `noteId: ${note.id}\nlevel: ${level}\n\n<!-- ↑の2行は消さないでください -->\n\n`,
    labels: `answer,level:${level}`,
  });
  return `https://github.com/${REPO}/issues/new?${params}`;
}

/**
 * ノート本文（軽いMarkdown）をメール用HTMLに起こす。
 * 対応するのは `## 見出し` / `- 箇条書き` / `**強調**` の3つだけ。
 * メールクライアントは <style> を落とすので、すべてインラインで書く。
 */
function renderNoteBody(markdown) {
  const inline = (s) =>
    escapeHtml(s).replace(
      /\*\*(.+?)\*\*/g,
      '<strong style="color:#2f2a22;">$1</strong>',
    );

  return String(markdown ?? "")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t === "") return "";
      if (t.startsWith("## ")) {
        return `<div style="font-size:15px;font-weight:700;color:#2f2a22;margin:22px 0 10px;">${inline(
          t.slice(3),
        )}</div>`;
      }
      if (t.startsWith("- ")) {
        return `<div style="font-size:14px;line-height:1.85;color:#4a4237;margin:0 0 8px;padding-left:14px;text-indent:-14px;">・${inline(
          t.slice(2),
        )}</div>`;
      }
      // 元のインデント（「→」の続き行など）は意味を持つので、字下げとして残す
      const indent = (line.match(/^ */)?.[0].length ?? 0) * 7;
      return `<div style="font-size:14px;line-height:1.85;color:#4a4237;margin:0 0 10px;padding-left:${indent}px;">${inline(
        t,
      )}</div>`;
    })
    .filter(Boolean)
    .join("");
}

const ANSWER_BUTTONS = [
  { level: "ok", label: "余裕でした", bg: "#3f7d4e" },
  { level: "vague", label: "あやしい", bg: "#b08430" },
  { level: "ng", label: "無理でした", bg: "#a4413a" },
];

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
          ${escapeHtml(character.emoji ?? "")} ${escapeHtml(character.name)}${
            character.nickname ? `（${escapeHtml(character.nickname)}）` : ""
          }から質問が届いています
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
            ${
              note.tags
                ? `<div style="font-size:11px;color:#cfe6d4;margin-top:10px;">
                     ${escapeHtml(String(note.tags).split(",").join(" ／ "))}
                   </div>`
                : ""
            }
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

      <tr><td style="padding:34px 0 0 0;">
        <div style="border-top:1px dashed #d8d0c2;padding-top:22px;">
          <div style="font-size:11px;color:#a99e8c;letter-spacing:.1em;margin-bottom:6px;">
            ここから下：そのとき書いたノート
          </div>
          <div style="font-size:12px;line-height:1.7;color:#9a8f7d;">
            先に自分の言葉で答えてみて、詰まったら読んでください。
          </div>
        </div>
      </td></tr>

      ${
        note.summary
          ? `<tr><td style="padding:18px 0 0 0;">
               <div style="font-size:13px;line-height:1.85;color:#5c5346;background:#f3efe6;
                           padding:14px 16px;border-radius:8px;">
                 ${escapeHtml(note.summary)}
               </div>
             </td></tr>`
          : ""
      }

      <tr><td style="padding:14px 0 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
               style="background:#ffffff;border:1px solid #e6e1d8;border-radius:12px;">
          <tr><td style="padding:20px 22px;">
            ${renderNoteBody(note.content)}
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:26px 0 0 0;">
        <div style="font-size:12px;color:#7d7365;margin-bottom:12px;">
          説明できたか、どれか押してください。押すと本文が埋まった状態で開くので、送信するだけです。<br>
          <span style="color:#a99e8c;">長く説明したい日は、開いた本文にそのまま書き足せます。</span>
        </div>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            ${ANSWER_BUTTONS.map(
              (b) => `<td style="padding-right:8px;">
              <a href="${answerUrl(note, b.level)}"
                 style="display:inline-block;background:${b.bg};color:#ffffff;text-decoration:none;
                        font-size:14px;font-weight:600;padding:11px 18px;border-radius:8px;">
                ${escapeHtml(b.label)}
              </a>
            </td>`,
            ).join("")}
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:26px 0 0 0;border-top:1px solid #e6e1d8;">
        <div style="font-size:11px;line-height:1.7;color:#a99e8c;">
          復習ステージ: ${escapeHtml(note.reviewStage ?? "新規")}<br>
          答えると次に進みます。答えなければステージは据え置きで、${RETRY_IN_DAYS}日後にもう一度来ます<br>
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
    ...(note.tags ? [String(note.tags).split(",").join(" / ")] : []),
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
    "=========================================",
    " ここから下：そのとき書いたノート",
    " 先に自分の言葉で答えてみて、詰まったら読んでください。",
    "=========================================",
    "",
    ...(note.summary ? [note.summary, ""] : []),
    String(note.content ?? "").trim(),
    "",
    "--- 説明できたか、どれか開いて送信してください ---",
    ...ANSWER_BUTTONS.map((b) => `${b.label}: ${answerUrl(note, b.level)}`),
    "",
    `復習ステージ: ${note.reviewStage ?? "新規"}（答えなければ据え置き、${RETRY_IN_DAYS}日後に再送）`,
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

/**
 * 送っただけではステージを進めない。
 *
 * 以前はここで reviewStage を1つ進めていたが、それだと「間隔をあけて送るタイマー」に過ぎず、
 * 説明できなかった項目まで 7→14→30 日と勝手に先送りされていた。
 * ステージを動かすのは回答が届いたとき（answer.mjs）だけにする。
 * 未回答のまま放置された場合は、据え置きのまま RETRY_IN_DAYS 日後にもう一度出す。
 */
function markSent(note) {
  return {
    reviewStage: note.reviewStage ?? "新規",
    nextReviewDate: addDaysJst(RETRY_IN_DAYS),
    status: "回答待ち",
    lastSentDate: todayJst(),
    awaitingAnswer: true,
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

  const state = await readState();
  const character = await loadCharacter(state);
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
  const subject = `${character.nickname ?? character.name}から質問です —「${note.mailHook ?? note.title}」`;

  if (dryRun) {
    // DRY_RUN_HTML にパスを渡すと、送らずに本文HTMLだけ書き出してブラウザで確認できる
    if (process.env.DRY_RUN_HTML) {
      await writeFile(process.env.DRY_RUN_HTML, html, "utf8");
      console.log(`HTMLを書き出しました: ${process.env.DRY_RUN_HTML}`);
    }
    console.log(`--- DRY RUN ---\nto: ${to ?? "(未設定)"}\nsubject: ${subject}\n\n${text}`);
    return;
  }

  const result = await sendMail({ apiKey, from, to, subject, html, text });
  console.log(`送信しました: ${note.id} (resend id: ${result.id})`);

  const patch = markSent(note);
  const { _file, ...rest } = note;
  await writeFile(
    path.join(NOTES_DIR, _file),
    `${JSON.stringify({ ...rest, ...patch }, null, 2)}\n`,
    "utf8",
  );

  state.history.unshift({
    sentAt: new Date().toISOString(),
    dateJst: todayJst(),
    noteId: note.id,
    charId: character.id ?? null,
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
