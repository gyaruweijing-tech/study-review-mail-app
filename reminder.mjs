/**
 * 単発リマインダー送信。復習メルマガ本体（send.mjs / state.json）には一切触らない。
 *
 * 環境変数:
 *   RESEND_API_KEY  必須。GitHub Secrets から渡る
 *   MAIL_TO         必須。宛先
 *   MAIL_FROM       省略可。既定は Resend の共有ドメイン
 *   FIRE_DATE       必須。JSTでこの日付(YYYY-MM-DD)のときだけ送る。
 *                   cron に年フィールドが無いため、来年の同じ日に誤爆するのを防ぐ番人
 *   SUBJECT / BODY  件名と本文（プレーンテキスト1行）
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 15000;

function todayInJst() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM || "onboarding@example.com";
  const fireDate = process.env.FIRE_DATE;
  const subject = process.env.SUBJECT || "リマインダー";
  const body = process.env.BODY || "";

  if (!apiKey || !to) {
    throw new Error("RESEND_API_KEY と MAIL_TO が必要です");
  }

  const today = todayInJst();
  if (fireDate && fireDate !== today) {
    console.log(`今日(JST ${today})は送信日(${fireDate})ではないので何もしません`);
    return;
  }

  const html = `<div style="font-family:sans-serif;font-size:16px;line-height:1.8;color:#222">
  <p style="margin:0 0 16px">${body.replace(/\n/g, "<br>")}</p>
  <p style="margin:0;color:#888;font-size:13px">— 明日の自分より</p>
</div>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text: body }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Resend ${response.status}: ${text}`);
    }
    console.log(`送信しました: ${JSON.parse(text).id}`);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Resend への送信が ${REQUEST_TIMEOUT_MS}ms でタイムアウトしました`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
