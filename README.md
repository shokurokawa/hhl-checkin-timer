# HHL Check-in Timer

ゼミの自己紹介タイムを進行するためのブラウザ完結型タイムキーピングアプリです。
進行役が「参加人数 / 持ち時間 / インターバル」を設定すると、`Speaking → Interval → Speaking → ...` の順で音付きに自動進行します。

- 1画面完結・スクロール禁止
- モノトーン・タイポグラフィ中心の静かなデザイン
- PCブラウザ・スマホブラウザ両対応（12インチPC / iPhone 13で1画面に収まる設計）
- 外部依存ゼロ（HTML / CSS / Vanilla JS のみ）
- 無料でGitHub Pages公開可能

---

## ファイル構成

```
260421_HHL_Check_in_timer/
├── index.html   # マークアップ
├── style.css    # スタイル
├── script.js    # タイマー本体（Web Audio API使用）
└── README.md    # このファイル
```

---

## 必要環境

モダンブラウザのみ（Safari / Chrome / Edge / Firefox 最新版）。
インターネット接続は初回ロード時のみ必要。以後はオフラインでも動作します。

---

## ローカルでの開き方

### 推奨: ローカルサーバー経由

`file://` で直接開くとブラウザによってはAudio APIが制限されることがあるため、簡易サーバー経由で開くことを推奨します。

```bash
cd "/Users/shokurokawa/Library/CloudStorage/GoogleDrive-sho@shokurokawa.net/マイドライブ/3_Apps/260421_HHL_Check_in_timer"
python3 -m http.server 8765
```

ブラウザで http://localhost:8765/ を開く。

### 簡易: ダブルクリック

`index.html` をダブルクリックでも動作します（音が出ない場合は上記の方法を使ってください）。

---

## 使い方

1. **Participants**（参加人数）を入力
2. **Speaking**（持ち時間）を 40s / 50s / 60s から選択（デフォルト 50s）
3. **Interval**（インターバル）を 5s / 10s から選択（デフォルト 10s）
4. **Total duration** に合計時間が自動表示される
5. **Start** ボタンを押すとタイマー開始
   - 各発表開始時にベル（「チーン」と余韻あり）
   - 残り5秒からチクタク音（5,4,3,2,1）
   - 発表終了時にベル
   - インターバルは「設定値 -1 秒」（5s設定なら 4,3,2,1 でチクタク → 次のベル）
   - 最後の発表者の後にはインターバルなし、完了ベルで終了
6. **Pause / Resume** で一時停止・再開
7. **Reset** で初期状態に戻る（入力値は保持）
8. ヘッダー右上の **Sound: On / Off** で音をミュートできる（タイマーは継続）

### 初期値

- Participants: **18**
- Speaking: **50s**
- Interval: **10s**
- Total duration: **17m 50s**

---

## 省電力・通信ゼロ設計

MacBook Air や iPhone の Safari / Chrome でタブを開きっぱなしにしてもバッテリー・通信を消費しないように設計されています。

- **外部リソース読み込みゼロ**: 外部CDN・Webフォント・解析タグなし。初回ロード以降のネットワーク通信は発生しません。
- **finished後の完全停止**: 全員終了後は `requestAnimationFrame` ループと `AudioContext` を解放し、画面更新・音声処理を一切行いません。
- **タブ非アクティブ時**: `visibilitychange` で描画ループを一時停止し、CPU使用を抑えます（実時間進行は維持）。

---

## GitHub Pages での公開手順

1. GitHubで新規リポジトリを作成（例: `hhl-checkin-timer`）。Public で作成。
2. このフォルダの中身をリポジトリにpush:

   ```bash
   cd "/Users/shokurokawa/Library/CloudStorage/GoogleDrive-sho@shokurokawa.net/マイドライブ/3_Apps/260421_HHL_Check_in_timer"
   git init
   git add index.html style.css script.js README.md
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/hhl-checkin-timer.git
   git push -u origin main
   ```

3. GitHub のリポジトリ画面で **Settings → Pages** を開く
4. **Source** を `Deploy from a branch` にし、Branch を `main` / フォルダを `/ (root)` に設定して Save
5. 数十秒〜数分後に `https://<your-username>.github.io/hhl-checkin-timer/` で公開される

---

## 既知の制約

- iOS Safariでは、ユーザーがStartボタンを押すまで音が鳴りません（autoplay制約のため）。Startを押せば以降は鳴ります。
- 古いブラウザ（IE等）では Web Audio API が使えないため、音は鳴りませんがタイマーは動作します。
- 端末のサイレントモード時は音が鳴らないことがあります（iPhoneのサイレントスイッチなど）。

---

## カスタマイズの目安

| 変更したい項目 | 変更箇所 |
|---|---|
| 持ち時間の選択肢を増やす | `index.html` の Speaking ラジオボタン |
| インターバルの選択肢を増やす | `index.html` の Interval ラジオボタン |
| 初期値（参加人数・持ち時間・インターバル） | `index.html` の `value="18"` と `checked` 属性 |
| 配色・余白 | `style.css` の `:root { --bg ... }` ブロック |
| 音色（周波数・長さ） | `script.js` の `playBell` / `playTick` / `playFinishBell` |
| 残り何秒からチクタク音にするか | `script.js` の `tickFrame()` 内 `sec >= 1 && sec <= 5` |
