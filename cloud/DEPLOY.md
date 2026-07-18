# デプロイ手順(フェーズ7: クラウド構成)

TailorTeX を GCP(Cloud Run)+ Firebase(Hosting / Auth / Firestore)へ
デプロイする手順書です。**ローカルモード(`node server.js`, ポート3000)は
これらの設定が無くても従来どおり動きます** — クラウドは追加のオプションです。

---

## 1. 前提

以下を満たしていること。

- **Firebase プロジェクトを作成済み**(<https://console.firebase.google.com/>)。
- **Blaze プラン(従量課金)** に切り替え済み。
  Cloud Run / Cloud Build / Artifact Registry は無料枠(Spark)では使えません。
- Firebase Authentication で **Google サインインを有効化**済み
  (Authentication → Sign-in method → Google → 有効)。
- 開発マシンに以下をインストール:
  - [`gcloud` CLI](https://cloud.google.com/sdk/docs/install)(`gcloud init` 済み)
  - Node.js 20 以上(`firebase` CLI は `npx firebase` でも可)
- ログイン:
  ```bash
  gcloud auth login
  gcloud auth application-default login   # set-admin.js / ADC 用
  firebase login                          # または npx firebase login
  ```

> **Docker は不要です。** コンテナのビルドは `gcloud builds submit` により
> **Cloud Build 側**で実行されるため、開発マシンに Docker Desktop / docker CLI が
> 入っていなくてもデプロイできます。ローカルで `docker build` したい場合のみ
> Docker が必要です。

有効化しておく GCP API(初回のみ。deploy.sh 実行時に案内される場合もあります):

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com --project <project-id>
```

---

## 2. プロジェクトIDの設定

リポジトリ直下の `.firebaserc` はプレースホルダ(`YOUR_FIREBASE_PROJECT_ID`)です。
`deploy.sh` は `--project <project-id>` で上書きするため通常は編集不要ですが、
`firebase emulators:start` などをIDなしで使いたい場合は書き換えてください。

`firebase.json` の Hosting rewrites と Cloud Run のリージョンは
`asia-northeast1`(東京)を既定にしています。別リージョンにする場合は
`firebase.json` の `region` と `deploy.sh` の第2引数を合わせてください。

---

## 3. デプロイ

```bash
./cloud/deploy.sh <project-id> [region]
# 例: ./cloud/deploy.sh my-firebase-proj asia-northeast1
```

> **Windows で実行する場合**: `deploy.sh` は bash スクリプトのため、**Git Bash
> または WSL(Ubuntu 等)から実行**してください(PowerShell/コマンドプロンプトからは
> 直接実行できません)。PowerShell 版(`.ps1`)は用意していません。Git Bash からは
> 上記コマンドをそのまま実行できます。

`deploy.sh` は次の3段階を実行します。

1. **Cloud Build でコンテナをビルド**
   `gcloud builds submit cloud/compile-service --tag gcr.io/<project-id>/word-latex-compile`
2. **Cloud Run にデプロイ**
   `gcloud run deploy word-latex-compile ...`
   （メモリ1Gi / CPU1 / タイムアウト120秒 / 同時実行1 / 最小0・最大2インスタンス /
   CPUブースト無効 / 環境変数 `FIREBASE_PROJECT_ID`。コスト最適化の詳細は
   「7. コスト」節を参照)
3. **Firebase Hosting・Firestore ルール/インデックスをデプロイ**
   `firebase deploy --only hosting,firestore:rules,firestore:indexes`

Hosting の rewrites により、`/compile`・`/compile-accessible`・`/admin/**` への
リクエストは Cloud Run サービス `word-latex-compile` に転送されます。

---

## 4. スーパーアドミンの付与

```bash
cd cloud
FIREBASE_PROJECT_ID=<project-id> node scripts/set-admin.js you@example.com superadmin
# 解除は:
FIREBASE_PROJECT_ID=<project-id> node scripts/set-admin.js you@example.com user
```

- 対象ユーザは **一度サインイン済み**である必要があります(未登録メールはエラー)。
- Custom Claims(`role`)と Firestore `users/{uid}.role` の両方を更新します。
- 反映は対象ユーザの**次回サインインまたはトークン更新後**です。

---

## 5. ローカルでのエミュレータ検証

Firebase Emulator Suite(auth 9099 / firestore 8080 / hosting 5000)で
本番に触れずに検証できます。

```bash
npm run emulators          # auth + firestore + hosting を起動
npm run test:rules         # Firestore ルールのユニットテスト(node --test)
```

`test:rules` は `firebase emulators:exec --only firestore "node --test test/rules.test.mjs"`
を実行します。**Firestore エミュレータには Java(JRE)が必要**です。未導入なら:

**macOS:**

```bash
brew install openjdk
export JAVA_HOME="$(brew --prefix openjdk)"
export PATH="$JAVA_HOME/bin:$PATH"
```

**Windows:** winget(または公式インストーラ <https://learn.microsoft.com/java/openjdk/>)で
OpenJDK を導入し、PowerShell で `JAVA_HOME` / `PATH` を設定します。

```powershell
winget install Microsoft.OpenJDK.21
# 現在のセッションに反映(インストール先はバージョンにより異なる)
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
# 恒久設定(新しいセッションから有効):
# [Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Microsoft\jdk-21", "User")
```

---

## 6. コンパイルサービス単体の動作確認

`Authorization: Bearer <IDトークン>` の検証は firebase-admin が行います。
Docker やクラウドなしでローカル確認するには **DEV モード**を使います。

既定ポートは Cloud Run と同じ 8080 ですが、Firestore エミュレータも 8080 を
使うため、ローカルで両方を並行して動かす場合は `PORT` を別値(例 8787)にします。
本番の Cloud Run はローカルサーバー(`node server.js`, ポート3000)とは無関係です。

```bash
# cloud/compile-service で(依存はルートの node_modules を共有 or ここで npm install)
CLOUD_COMPILE_DEV=1 PORT=8787 node cloud/compile-service/index.js
# 別ターミナルで:
# 無トークン → 401
curl -i -X POST localhost:8787/compile -d '{"latex":"..."}'
# 有効トークン(DEVでは任意の文字列)→ 200(%PDF)
curl -sS -X POST localhost:8787/compile \
  -H 'Authorization: Bearer devtoken' \
  -H 'Content-Type: application/json' \
  -d '{"latex":"\\documentclass{article}\\begin{document}Hello\\end{document}"}' \
  -o out.pdf
# 管理API: superadmin を含むトークンは DEV モードで superadmin 扱い(→ 200)
curl -s localhost:8787/admin/users -H 'Authorization: Bearer my-superadmin-token'
```

DEV モードでは `superadmin` を含むトークン文字列を superadmin 扱いにします
(`/admin/users` の動作確認用)。本番の Cloud Run では `CLOUD_COMPILE_DEV` を
設定しないでください(必ず本物のIDトークン検証が働きます)。

---

## 7. コスト(重要)

個人・少人数の低頻度利用であれば **ほぼ無料枠内** に収まる構成にしています。
`deploy.sh` の Cloud Run フラグと app.js の自動保存デバウンスがこの前提を支えます。

### Cloud Run を scale-to-zero に

`--min-instances=0` によりリクエストが無い間は**インスタンスが 0 になり課金されません**
(scale-to-zero)。次のリクエストでコールドスタート(TeX Live イメージのため数秒)が
発生しますが、常時起動の固定費を避けられます。`--max-instances=2` で万一の暴走時も
最大 2 インスタンスに抑え、`--concurrency=1`(コンパイルは CPU バウンドで直列前提)、
`--cpu=1` / `--memory=1Gi` / `--no-cpu-boost` で 1 リクエストあたりの単価を最小化します。

**コスト目安**(asia-northeast1、2026年時点の概算。正確な単価は
<https://cloud.google.com/run/pricing> を参照):

- Cloud Run には毎月の無料枠(vCPU 秒・GiB 秒・リクエスト 200万件/月)があります。
- 1回のコンパイルを CPU1・1GiB で約10秒とすると、**1日20回・月600回**でも
  課金対象は概ね **月 100〜200円未満**、多くの月は**無料枠内でほぼ 0 円**です。
- 常時起動(min-instances≥1)にすると固定で月数千円かかるため、既定は 0 のままを推奨。

### 予算アラート(必ず設定)

想定外の課金を早期に検知するため、**予算アラートの設定を強く推奨**します。
請求先アカウントID(`gcloud billing accounts list` で確認)を使って、月 $5 の予算に
50% / 90% / 100% でアラートする例:

```bash
# 請求先アカウントIDを確認
gcloud billing accounts list

# 月 $5 の予算を作成し 50/90/100% でメール通知
gcloud billing budgets create \
  --billing-account=XXXXXX-XXXXXX-XXXXXX \
  --display-name="tailortex budget" \
  --budget-amount=5USD \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```

> `gcloud billing budgets create` には Cloud Billing Budget API
> (`billingbudgets.googleapis.com`)の有効化と `roles/billing.admin` が必要です。
> Cloud Console の「お支払い → 予算とアラート」からGUIでも同じ設定ができます。

### Firestore 書き込みコストと8秒デバウンス

Firestore の無料枠は **書き込み 2万件/日・読み取り 5万件/日**(Spark/Blaze 共通)です。
自動保存を1秒デバウンスのままにすると、1文書を数分編集しただけで数十〜百件の書き込みが
発生し、複数ユーザーでは無料枠を圧迫します。そこで **クラウドモードの自動保存デバウンスを
8秒**に延ばし(ローカルモードは従来1秒のまま)、さらに**前回保存と内容ハッシュを比較して
無変化なら書き込みをスキップ**します。加えて `blur` / タブ非表示で保留中の保存を即時
フラッシュするため、8秒待ちによる保存漏れは起きません。

目安として、8秒デバウンスなら連続編集中でも書き込みは概ね **1分あたり最大7〜8件**に
収まり、1ユーザーが1日中編集しても無料枠(2万/日)に対して十分な余裕があります。

### イメージサイズの削減

コンテナは `texlive-full`(数GB)ではなく **`scheme-small` + 必要コレクションのみ**
(`collection-langjapanese` / `collection-luatex` ほか)で構築しています。イメージが
小さいほど Cloud Build のビルド時間・Artifact Registry のストレージ課金・コールド
スタート時のイメージ取得時間がいずれも小さくなります(Dockerfile 参照)。

---

## 7b. Storage(バイナリ資産)のコストと設定(フェーズ19)

画像・添付PDF は Firestore(1MB/doc 上限)に base64 で埋めず、**内容アドレス方式**
(キー = ファイル内容の SHA-256)で別ストアに保存し、Firestore の html には参照だけを
置きます。これにより Firestore doc は常に小さく保たれます。

- **クラウドモード**: Firebase Storage の `docs/{docId}/assets/{sha256}.{ext}` に保存。
- **ローカルモード**: `projects/<id>/assets/{sha256}.{ext}`(ディスク)。**Storage を一切
  使わないので費用ゼロ**(現状維持)。

### 参照フォーマット契約(フロントと共有)

フロント(`public/js/assets.js` の `window.Assets`)とバックエンド(`cloud/storage.rules` /
ローカル `PUT /projects/:id/file`)で以下を共有します。

| 項目 | 値 |
| --- | --- |
| 資産キー | ファイル内容の **SHA-256**(重複排除。同一ファイルは1回だけ保存) |
| Storage パス | `docs/{docId}/assets/{sha256}.{ext}` |
| 参照文字列 | `asset:{docId}/{sha256}.{ext}`(`assets.js` が Storage URL / ローカルパスに解決) |

`cloud/storage.rules` のパス設計(`match /docs/{docId}/assets/{fileName}`)はこの契約と
一致しています。

### Storage セキュリティルール(`cloud/storage.rules`)

Firestore の `docs/{docId}.access`(`{uid: role}`)と整合させています(`firestore.get`
でクロスサービス参照)。

- **read**: その doc のメンバー(`owner` / `editor` / `commenter` / `viewer`)。
- **write**: `owner` / `editor` のみ。
- **未認証は一律拒否**。**1ファイル 50MB 未満**(delete は `request.resource == null`)。
- 旧モデル(`ownerUid` / `collaborators`)のメンバーも許可。`superadmin` は全権。

`firebase.json` に `"storage": { "rules": "cloud/storage.rules" }` を登録済み。デプロイは
Firestore ルールと同様、`firebase deploy --only storage`(または `--only storage:rules`)で
反映します。

ルールのユニットテスト(Storage エミュレータ port 9199 + Firestore エミュレータ)。
Java の導入は「5. ローカルでのエミュレータ検証」の OS 別手順を参照してください
(macOS: `brew install openjdk` / Windows: `winget install Microsoft.OpenJDK.21`)。

```bash
# macOS(Windows は PowerShell で JAVA_HOME/PATH を設定、上記5節参照)
export JAVA_HOME="$(brew --prefix openjdk)"
export PATH="$JAVA_HOME/bin:$PATH"
# --project は demo- で始まる ID を推奨(クロスサービス firestore.get のため
# テストの projectId は GCLOUD_PROJECT に自動追従する)
firebase emulators:exec --project demo-wll --only storage,firestore \
  "node --test test/storage.rules.test.mjs"
```

owner write可 / editor write可 / commenter・viewer は read可・write不可 /
非メンバー read不可 / 未認証拒否 / 50MB超拒否 / 旧モデル / superadmin を検証します。

### 無料枠(Firebase Storage)と試算

Firebase Storage(Blaze)の**無料枠**は概ね **保存 5GB / ダウンロード 1GB・日 /
アップロード 20,000件・日 / ダウンロード 50,000件・日**(2026年時点。正確な値は
<https://firebase.google.com/pricing> を参照)。

- **研究者1人・少人数の低頻度利用なら実質無料**です。論文用の画像・添付PDF が数百MB〜
  1GB 程度に収まる限り、保存もダウンロードも無料枠内で **0 円**。
- 目安の**超過単価**(us / asia、概算): 保存 STANDARD ≈ **$0.026/GB/月**、
  Nearline ≈ **$0.01/GB/月**、ダウンロード ≈ **$0.12/GB**。例えば 10GB を常時保存しても
  月 $0.26 程度、無料枠超過分だけが課金対象です。
- コスト最適化(実装済み方針):
  - **build/・生成 main.pdf・main.tex はアップロードしない**(再生成物は保存・転送しない)。
  - **重複排除**(SHA-256 キー): 同じ画像/PDF は1回だけ保存。
  - 画像は **URL 参照で遅延読み込み**(ブラウザキャッシュ)。一覧でサムネ不要なら取得しない。
  - 添付PDF は書き換えられない(内容アドレス方式で immutable)ため、**Nearline へ自動移行**
    (下記ライフサイクル)。

### GCS ライフサイクル(添付PDF を Nearline へ)

Storage のライフサイクルは `firebase.json` ではなく **GCS バケット側**に設定します
(`firebase.json` は lifecycle フィールドを持たないため)。設定は
`cloud/storage.lifecycle.json` にあり、**30日を過ぎた `.pdf` を STANDARD → Nearline**
へ移行します(頻繁に URL 参照で読む画像は取得課金のある Nearline には落とさず STANDARD の
まま)。適用手順:

```bash
# バケット名を確認(通常は <project-id>.appspot.com)
gsutil ls

# ライフサイクルを適用
gsutil lifecycle set cloud/storage.lifecycle.json gs://<project-id>.appspot.com
# 確認
gsutil lifecycle get gs://<project-id>.appspot.com

# gcloud storage でも同等(--lifecycle-file は同じ JSON 形式):
gcloud storage buckets update gs://<project-id>.appspot.com \
  --lifecycle-file=cloud/storage.lifecycle.json
```

### 予算アラート(Storage 込み)

「7. コスト」の予算アラートは**プロジェクト全体の課金**(Cloud Run + Storage + Firestore
など)を対象にするため、Storage の想定外増加もこの予算で検知できます。Storage を含めて
確実に検知したい場合の月 $5 予算の例(フェーズ10d を Storage 向けに拡張):

```bash
gcloud billing accounts list   # 請求先アカウントIDを確認

gcloud billing budgets create \
  --billing-account=XXXXXX-XXXXXX-XXXXXX \
  --display-name="tailortex budget (Run+Storage+Firestore)" \
  --budget-amount=5USD \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```

> `--filter-projects` などでプロジェクトを絞れます。既定(フィルタ無し)は請求先アカウント
> 配下の全プロジェクト・全サービス(Storage を含む)が対象です。Cloud Console の
> 「お支払い → 予算とアラート」からGUIでも同じ設定ができます。

---

## 8. トラブルシュート

| 症状 | 原因と対処 |
| --- | --- |
| `PERMISSION_DENIED` / `Blaze required` | プロジェクトを Blaze プランへ。Cloud Build/Run API を有効化。 |
| `gcloud builds submit` が権限エラー | `roles/cloudbuild.builds.editor` と Artifact Registry / Cloud Run の権限を付与。 |
| Cloud Run で 401 が返る | クライアントが正しい Firebase IDトークンを送っているか、`FIREBASE_PROJECT_ID` が一致しているか確認。 |
| `/admin/users` が 403 | 呼び出しトークンに `role=superadmin` が無い。`set-admin.js` 実行後に再ログインしてトークン更新。 |
| ルールテストが `Could not start Firestore Emulator` | Java(JRE)未導入。macOS は `brew install openjdk`、Windows は `winget install Microsoft.OpenJDK.21` して `JAVA_HOME`/`PATH` を設定(5節参照)。 |
| 日本語が PDF に出ない | イメージに `collection-langjapanese` が入っているか(Dockerfile の tlmgr install)。`bxjs`/`ltjs`/`jlreq`/`luatexja` を使用。 |
| ビルドが遅い/巨大 | `scheme-small` + 必要コレクションのみ。`texlive-full` は使わない。 |
| Storage ルールテストで member が `storage/unauthorized` | クロスサービス `firestore.get` は Storage バケットと同じ project の Firestore を読む。テストの `projectId` を emulator の `--project`(`GCLOUD_PROJECT`)に合わせる(本テストは自動追従)。 |
| Storage ルールで `Property X is undefined on object` | Storage ルールは不在キー/クレーム参照が例外になる(Firestore より厳格)。`'role' in request.auth.token`・`uid in ...access` のように存在確認してから参照する。 |
| Firestore の doc が 1MB 超で保存失敗 | base64 画像が html に埋まっている。フェーズ19 で資産は Storage/assets へ抽出され参照化される。既存文書は次回保存で移行。 |

### Docker を使わないことについて

このリポジトリの開発環境には Docker が入っていません。`deploy.sh` は
`gcloud builds submit` を使うため、**Dockerfile のビルドは Cloud Build 上で
実行**されます。したがってローカルに Docker は不要です。ローカルで
イメージを検証したい場合のみ:

```bash
docker build -t word-latex-compile cloud/compile-service
docker run -p 8080:8080 -e CLOUD_COMPILE_DEV=1 word-latex-compile
```

> 注: 本手順書作成時点の開発マシンには Docker 未導入のため、`docker build` は
> 未実行です。Dockerfile はマルチステージ構成(TeX Live を tlmgr で scheme-small +
> collection-langjapanese + collection-luatex + 必要パッケージで構築 → node:20-slim
> に載せる)で静的レビュー済みです。実ビルドは Cloud Build で行ってください。
