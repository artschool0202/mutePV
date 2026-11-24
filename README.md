# 音なしPV v1（2026-11-24）

登録したアーティストの PV を YouTube で検索し、音なし・横向き全画面で流し続ける Webアプリ。Rakuten Mini（Android 9 の Chrome）で置きっぱなしにする想定。

公開予定：https://artschool0202.github.io/mutepv/（GitHub リポジトリ artschool0202/mutepv を作って置く）

## しくみ

- 検索：YouTube Data API v3 の search（アーティスト名＋「MV」、音楽カテゴリ、埋め込み可の動画だけ。1人25件）
  - 題名かチャンネル名にアーティスト名が入っている動画を優先（カバー動画を減らす）
  - 検索結果は端末に1日保存して使い回す。1回の検索で API の使用量を100使い、無料枠は1日10,000（＝約100回）
- 再生：YouTube 公式の埋め込みプレーヤー（IFrame Player API）。常にミュート、操作画面なし、シャッフルで延々ループ
  - 埋め込み禁止・削除済みで再生できない動画は自動で飛ばし、次からも飛ばす
- API キーがなくても、設定の「YouTube のURL」に動画やプレイリストのURLを入れれば再生できる
- 設定（アーティスト・キーなど）は端末の中にだけ保存する。キーはコードやGitHubには書かない

## 操作

| 操作 | 動き |
| --- | --- |
| 画面をタップ | 右上にボタンを出す（5秒で消える）。今の曲名も出す |
| ⏭ | 次の動画へ |
| 目 | 画面消灯防止（最初からON） |
| □ | 全画面のオン／オフ |
| ⚙ | 設定（アーティスト、検索に付ける言葉、API キー、URL） |

## 設定を QR コードで渡す

`https://artschool0202.github.io/mutepv/#key=APIキー&artists=アーティスト1|アーティスト2` を開くと、その内容が端末に保存される（開いたあと URL からキーは消える）。

## ファイル

index.html / style.css / app.js / manifest.json / sw.js（CACHE は mutepv-v1）/ icon.svg / icon-192.png / icon-512.png
