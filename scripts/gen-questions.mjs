/**
 * ノートから「後輩キャラが聞いてくる質問」を3つ作って notes/*.json に焼き込む。
 *
 * ここだけが AI を呼ぶ。木曜の配信（send.mjs）は一切 AI に依存しない。
 * 生成が失敗しても、送信側は見出しから組み立てるフォールバックで回り続ける。
 *
 * 使い方（ローカルのみ。GitHub Actions からは動かさない）:
 *   node --env-file=.env scripts/gen-questions.mjs            # questions が空のノート全部
 *   node --env-file=.env scripts/gen-questions.mjs --dry-run  # 書き込まずに表示だけ
 *   node --env-file=.env scripts/gen-questions.mjs --id <noteId>
 *   node --env-file=.env scripts/gen-questions.mjs --id <noteId> --force  # 既存を上書き
 *
 * 環境変数:
 *   ANTHROPIC_API_KEY  必須。.env に置く（.gitignore 済み）
 *   GEN_MODEL          省略可。既定は claude-opus-5
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const NOTES_DIR = "notes";
const CHARACTER_FILE = "character.json";
const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5";
const REQUEST_TIMEOUT_MS = 180_000;

/** 出力の形をAPI側で固定する。JSONパース失敗というリトライ理由を消すため。 */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "ちょうど3つ。ノートの急所を順に突く。",
      items: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description:
              "後輩が実際に口に出す質問。1〜3文。素朴だが急所を外さないこと。",
          },
          hint: {
            type: "string",
            description:
              "その後輩が自分なりに立てた（たいてい微妙にズレている）仮説。1文。",
          },
        },
        required: ["q", "hint"],
        additionalProperties: false,
      },
    },
    mailHook: {
      type: "string",
      description: "メール件名に使う、20字前後の引っかかるフレーズ。",
    },
  },
  required: ["questions", "mailHook"],
  additionalProperties: false,
};

const SYSTEM = `あなたは、学習ノートを読んだ「後輩エンジニア」になりきって質問を作る。
作った質問は復習メールとして本人に届き、本人が自分の言葉で説明できるかを試す道具になる。

## 守ること（キャラの掟）
- 採点しない。「不正解です」ではなく「そこがまだピンと来なくて」と言う。
- 知識レベルは低いまま固定。急に賢くならない。専門用語を使いこなさない。
- ノート本文は読んでいるが、理解はしていない。だから急所を突ける。
- 理解度の判定はしない。純粋に「教えてほしい」だけ。

## 良い質問の条件
- **ノートを読み返さずに答えられない**こと。見出しをなぞるだけの質問（「〇〇のところ、これって結局どういうことですか？」）は最悪。
- **一番説明しにくい所**を狙う。直感に反する主張、対比、因果関係、「なぜそうなるのか」。
- 具体的な語をノートから引用する。抽象的な言い換えで済ませない。
- 3つはバラけさせる。同じ論点を3回聞かない。
- hint には、後輩が勝手に立てた微妙にズレた仮説を書く。これが「違う違う」と説明したくなる燃料になる。

## お手本
q: 「レストランが本当に売ってるのは料理じゃなくて『席×時間』だ、って書いてあったんですけど…お客さんって料理にお金払ってますよね？ 何がどう違うんですか？」
hint: 「『回転率が大事』ってことですか？ でもそれ、普通に当たり前な気もして…。」

q: 「学習用のデータセンターは集中させて、推論用は分散させる、って真逆なのが謎です。どっちも同じGPUを置いてるのに、なんで置き方が逆になるんですか？」
hint: 「たくさん集めたほうが速いんじゃないんですか…？」

日本語で書く。`;

function buildUserPrompt(note) {
  return [
    "次のノートについて、質問を3つと、メール件名用のフックを1つ作ってください。",
    "",
    `# ${note.title}`,
    `日付: ${note.date} / 出典: ${note.source ?? "不明"}`,
    note.tags ? `タグ: ${note.tags}` : "",
    "",
    note.summary ? `## 要約\n${note.summary}\n` : "",
    "## 本文",
    String(note.content ?? "").trim(),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function callClaude({ apiKey, model, note }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: {
          format: {
            type: "json_schema",
            schema: OUTPUT_SCHEMA,
          },
        },
        messages: [{ role: "user", content: buildUserPrompt(note) }],
      }),
      signal: controller.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.error?.message ?? JSON.stringify(body).slice(0, 300);
      throw new Error(`Anthropic API ${res.status}: ${detail}`);
    }
    if (body.stop_reason === "refusal") {
      throw new Error(`生成を拒否されました (${body.stop_details?.category ?? "不明"})`);
    }
    if (body.stop_reason === "max_tokens") {
      throw new Error("max_tokens に達して途中で切れました");
    }

    // thinking ブロックが先に来るので、text ブロックを拾う
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) throw new Error("本文が空でした");

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/** 掟破りを機械的に弾く。数が違う／空／見出しなぞりの定型文。 */
function validate(result) {
  const qs = result?.questions;
  if (!Array.isArray(qs) || qs.length !== 3) {
    throw new Error(`questions が3つではありません (${qs?.length ?? 0})`);
  }
  for (const [i, item] of qs.entries()) {
    if (!item?.q?.trim() || !item?.hint?.trim()) {
      throw new Error(`Q${i + 1} の q または hint が空です`);
    }
    if (/これって結局どういうこと/.test(item.q)) {
      throw new Error(`Q${i + 1} が見出しをなぞっただけの定型文です`);
    }
  }
  if (!result?.mailHook?.trim()) throw new Error("mailHook が空です");
  return result;
}

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, id: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i] === "--force") opts.force = true;
    else if (argv[i] === "--id") opts.id = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "ANTHROPIC_API_KEY がありません。.env に置いて `node --env-file=.env` で実行してください",
    );
    process.exitCode = 1;
    return;
  }
  const model = process.env.GEN_MODEL || DEFAULT_MODEL;

  const files = (await readdir(NOTES_DIR)).filter((f) => f.endsWith(".json"));
  const targets = [];
  for (const file of files) {
    const full = path.join(NOTES_DIR, file);
    const note = JSON.parse(await readFile(full, "utf8"));
    if (opts.id && note.id !== opts.id) continue;
    const hasQuestions = Array.isArray(note.questions) && note.questions.length > 0;
    if (hasQuestions && !opts.force) continue;
    targets.push({ full, note });
  }

  if (targets.length === 0) {
    console.log("対象のノートはありません（--force で既存も作り直せます）");
    return;
  }
  console.log(`対象 ${targets.length} 件 / モデル ${model}${opts.dryRun ? " / DRY RUN" : ""}\n`);

  let failed = 0;
  for (const { full, note } of targets) {
    process.stdout.write(`- ${note.id} ... `);
    try {
      const result = validate(await callClaude({ apiKey, model, note }));
      console.log("OK");
      for (const [i, item] of result.questions.entries()) {
        console.log(`    Q${i + 1}. ${item.q}`);
        console.log(`        (${item.hint})`);
      }
      console.log(`    hook: ${result.mailHook}`);

      if (!opts.dryRun) {
        // mailHook は既にあれば尊重する（手で直した件名を上書きしない）
        const updated = {
          ...note,
          questions: result.questions,
          mailHook: note.mailHook || result.mailHook,
        };
        await writeFile(full, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      }
      console.log("");
    } catch (err) {
      failed++;
      console.log(`失敗: ${err.message}\n`);
    }
  }

  if (failed > 0) {
    console.error(`${failed} 件が失敗しました（成功分は書き込み済み）`);
    process.exitCode = 1;
  } else if (opts.dryRun) {
    console.log("DRY RUN のため何も書き込んでいません");
  } else {
    console.log("notes/ を更新しました。中身を確認してから commit してください");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
