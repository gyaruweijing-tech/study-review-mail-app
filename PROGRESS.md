# study-review-mail — 進捗

MulmoClaude の学習ノート（`data/study-review`）を、週1で「後輩からの質問メール」として自分に届ける仕組み。

## なぜこの構成か

PCが常時起動していない（平日日中は電源が落ちている）。だから**送信をクラウド側に置く**。
ローカルの役目は「ノートをGitHubに届けること」だけで、週1配信なら週に一度PCが起動していれば足りる。

```
ローカルPC（起動時だけ）                GitHub（常時）
mulmoclaude/data/study-review/items/
        │ scripts/sync.mjs
        ▼
   notes/*.json ──push──▶  リポジトリ ──cron──▶ send.mjs ──▶ Resend ──▶ スマホ
                                  ▲                             │
                                  └──── 復習状態を commit ◀──────┘
```

## データの持ち主（同期の向き）

| フィールド | 正 |
|---|---|
| title / date / source / tags / summary / content | MulmoClaude 側 |
| reviewStage / nextReviewDate / status / lastSentDate / questions / mailHook | このリポジトリ側 |

`scripts/sync.mjs` はこの境界を守ってマージする（Actions が書いた復習状態を上書きしない）。

## 配信設定

- 本番: **毎週木曜 07:00 JST**（= 水曜 22:00 UTC / cron `0 22 * * 3`）
- 1通1件。`nextReviewDate` が古い順、同着なら学習日が古い順
- 送信後、復習ステージを1段進めて `nextReviewDate` を先送り（7→14→30→60→120日）
- GitHub Actions の cron は混雑時に5〜30分遅れる。時刻厳守ではない

## 生徒キャラ

`character.json`。エンジニア1年目の後輩「ハル」。設計上の掟は同ファイルの `rules` を参照。
要点は **採点しない・急に賢くならない・3往復で満足して去る・理解度判定は裏でやる**。

## 状況

### 完了
- [x] ノート取り込み（sync.mjs、境界を守るマージ）
- [x] 送信本体（send.mjs、選択→HTML/テキスト生成→Resend→復習状態の更新）
- [x] GitHub Actions ワークフロー（週次 cron + 手動実行 + 書き戻し commit）
- [x] キャラ定義とHTMLメールのデザイン（白基調）
- [x] `ai-infra-restaurant-harness-20260617` に質問3件を手書き

### 未着手
- [ ] 残り3件のノートに質問を書く（無い場合は見出しからの自動生成にフォールバックする）
- [ ] 質問生成をノート取り込み時に自動化（MulmoClaude 側で `questions` を一緒に吐かせる）
- [ ] **答え合わせのUI**（メールのリンク → Webで ハル と会話 → 裏で理解度判定 → `nextReviewDate` に反映）
- [ ] Actions が更新した復習状態を、ローカルの MulmoClaude 側へ書き戻す逆同期
- [ ] 独自ドメイン設定（今は `onboarding@example.com` 共有ドメインなので迷惑メール判定されやすい）

## ログ

### 2026-08-05
- 設計と実装。ローカル案（タスクスケジューラ）は「平日日中PCが落ちている」ため破棄し、GitHub Actions 構成に変更
- 12:00 JST に実験送信を仕込んだ（cron `0 3 5 8 *`）。**テストが済んだらこの cron 行は消すこと**
