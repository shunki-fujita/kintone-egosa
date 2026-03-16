# kintone エゴサ - 仕様書

Chrome 拡張機能 (Manifest V3)
kintone の全文検索を定期実行し、新規ヒット時にデスクトップ通知を送る。

## 1. 概要

| 項目 | 内容 |
|---|---|
| 名称 | kintone エゴサ |
| バージョン | 1.0.0 |
| 種別 | Chrome 拡張機能 (Manifest V3) |
| 目的 | kintone 上の投稿をキーワードで定期的に検索し、前回検索時になかった新規コンテンツをデスクトップ通知で知らせる |

## 2. 前提条件

- Google Chrome (Manifest V3 対応バージョン)
- ブラウザで対象の kintone 環境 (`*.cybozu.com`) にログイン済みであること

## 3. ファイル構成

```
kintone-egosa/
├── manifest.json   # 拡張機能のマニフェスト定義
├── background.js   # Service Worker (検索・通知ロジック)
├── popup.html      # 設定画面の HTML
├── popup.js        # 設定画面のロジック
├── popup.css       # 設定画面のスタイル
├── icon.png        # アイコン (128x128)
└── README.md       # 本ファイル
```

## 4. 権限

**permissions:**

| 権限 | 用途 |
|---|---|
| `alarms` | 定期実行タイマー |
| `notifications` | デスクトップ通知 |
| `storage` | 設定・既読情報の永続化 |
| `tabs` | kintone タブの検索・作成 |
| `scripting` | kintone タブ内でのスクリプト実行 |

**host_permissions:**

- `https://*.cybozu.com/*` — kintone 環境へのアクセス

## 5. 設定画面 (popup)

### 5.1 サブドメイン

- kintone の URL の `{subdomain}.cybozu.com` 部分

### 5.2 キーワード

- 検索するキーワードを1行に1つずつ記入
- 複数キーワードの場合はそれぞれ順番に検索する

### 5.3 検索対象 (groupTypes)

以下から1つ以上を選択 (チェックボックス):

| 表示名 | 値 | 備考 |
|---|---|---|
| レコード | `RECORD` | |
| コメント | `RECORD_COMMENT` | |
| スペース | `SPACE` | API 上は `THREAD_POST` |
| ピープル | `PEOPLE` | |
| メッセージ | `MESSAGE` | |
| ファイル | `FILE` | |

### 5.4 検索間隔

1分 / 3分 / **5分(デフォルト)** / 10分 / 30分 から選択

### 5.5 自動停止

- チェックボックス + time 入力で有効/無効と時刻を設定
- デフォルト: **有効、19:00**
- アラーム発火時に現在時刻が設定時刻以降であれば監視を自動停止する

### 5.6 操作ボタン

- **「保存して開始」** — 設定を保存し、定期検索を開始
- **「停止」** — 定期検索を停止

### 5.7 ステータス表示

- 監視中 / 停止中
- 最終検索時刻
- 検索間隔
- 自動停止時刻 (設定時)
- 前回の新規ヒット件数
- エラーメッセージ (あれば)

## 6. 検索の仕組み

### 6.1 検索方式

1. `chrome.tabs.query` で開いている kintone タブを検索
2. タブがない場合はポータル (`/k/`) を `active: false` で自動的に開く
3. 見つかった (または開いた) タブに `chrome.scripting.executeScript` (`world: 'MAIN'`) で検索スクリプトを注入
4. スクリプトはタブのメインワールドで実行されるため、kintone のセッション Cookie と CSRF トークンが利用できる

### 6.2 CSRF トークン取得

`window.cybozu.data.REQUEST_TOKEN` から直接取得

### 6.3 検索 API

- **エンドポイント:** `POST /k/api/search/search.json`
- **リクエストボディ:**

```json
{
  "keyword": "検索キーワード",
  "start": 0,
  "tzOffset": 540,
  "__REQUEST_TOKEN__": "(CSRFトークン)"
}
```

- **レスポンス:**

```json
{
  "result": {
    "docs": [ ... ],
    "numFetched": 20,
    "continuable": true
  },
  "success": true
}
```

### 6.4 検索結果のフィルタリング

API レスポンスの `doc.type` を設定の groupTypes にマッピング:

| API の type | groupType |
|---|---|
| `THREAD_POST` | `SPACE` |
| `RECORD` | `RECORD` |
| `RECORD_COMMENT` | `RECORD_COMMENT` |
| `PEOPLE` | `PEOPLE` |
| `MESSAGE` | `MESSAGE` |
| `FILE` | `FILE` |

ユーザーが選択した groupTypes に該当するものだけ抽出する。

### 6.5 新規ヒットの判定

- 各検索結果の `doc.id` をユニークキーとして使用
- `chrome.storage.local` に既読 ID のセットを保持 (`seenIds`)
- 初回検索時は全結果を既読として登録 (通知なし)
- 2回目以降は `seenIds` にない ID を新規ヒットとして通知
- 既読 ID は最大 **10,000 件**に制限 (古いものから削除)

### 6.6 複数キーワードの処理

- 設定されたキーワードを順番に1つずつ検索
- 各キーワードの間に **1 秒**のインターバル

## 7. 通知

### 7.1 個別通知 (最大5件)

| 項目 | 内容 |
|---|---|
| タイトル | `{投稿者名} が "{キーワード}" に言及` (投稿者不明時: `"{キーワード}" の新規ヒット`) |
| 本文 1行目 | 場所 (スペース名 > スレッド名、またはアプリ名) |
| 本文 2行目 | ハイライトスニペット (キーワード部分を【】で囲む) |
| contextMessage | コンテンツの種別 (スペース / レコード / コメント 等) |
| クリック時 | 該当コンテンツの URL を新規タブで開く |

### 7.2 オーバーフロー通知 (6件以上の場合)

| 項目 | 内容 |
|---|---|
| タイトル | `kintone エゴサ` |
| 本文 | `他 N 件の新規ヒット` |
| クリック時 | kintone の検索ページを開く |

## 8. URL の構築ルール

| コンテンツ種類 | URL パターン |
|---|---|
| レコード / コメント | `https://{subdomain}.cybozu.com/k/{appId}/show#record={recordId}` |
| スペース (スレッド投稿) | `https://{subdomain}.cybozu.com/k/#/space/{spaceId}/thread/{threadId}/{postId}/{postCommentId}` |
| ピープル | `https://{subdomain}.cybozu.com/k/#/people/user/{userCode}` |
| メッセージ | `https://{subdomain}.cybozu.com/k/#/message` |

## 9. データ永続化 (chrome.storage.local)

| キー | 型 | 説明 |
|---|---|---|
| `config` | `Object` | ユーザー設定 |
| `config.subdomain` | `string` | サブドメイン |
| `config.keywords` | `string` | キーワード (改行区切り) |
| `config.interval` | `number` | 検索間隔 (分) |
| `config.groupTypes` | `string[]` | 検索対象の種別 |
| `config.autoStopTime` | `string?` | 自動停止時刻 (`"HH:MM"`, `null`=無効) |
| `monitoring` | `boolean` | 監視中かどうか |
| `seenIds` | `string[]` | 既読の doc.id 一覧 (最大10,000) |
| `initialized` | `boolean` | 初回スキャン完了フラグ |
| `storageVersion` | `number` | ストレージ形式のバージョン (現在: 2) |
| `lastSearchTime` | `number` | 最終検索時刻 (Unix ms) |
| `lastHitCount` | `number` | 前回の新規ヒット件数 |
| `lastError` | `string?` | 直近のエラーメッセージ (正常時は `null`) |
| `notifUrls` | `Object` | 通知ID → URL のマッピング (最大100件) |

## 10. 定期実行

- `chrome.alarms` API を使用
- アラーム名: `kintone-egosa`
- 「保存して開始」時: 0.1分後に初回実行、以降は設定間隔で繰り返し
- Service Worker 再起動時: `monitoring=true` かつアラーム未登録なら自動復帰

## 11. エラーハンドリング

| 状況 | 表示メッセージ |
|---|---|
| kintone にログインしていない (ログインページへリダイレクト検出) | `SESSION_EXPIRED` |
| CSRF トークン取得失敗 | `NO_TOKEN` |
| API リクエスト失敗 (HTTP エラー) | `FETCH_FAILED:{ステータスコード}` |
| API レスポンスが失敗 | `API_FAILED` |
| タブ読み込みタイムアウト | `TAB_TIMEOUT` |
| その他の例外 | 例外メッセージをそのまま表示 |

## 12. 制限事項・注意点

- 検索 API は1回あたり最大20件を返す (ページネーション未実装)
- kintone にログインしていない場合は動作しない
- kintone タブが開いていない場合はポータルを自動で開く
- Service Worker はブラウザにより自動停止されるが、alarms により定期的に再起動される
- 通知の表示形式は OS のネイティブ通知に依存する
