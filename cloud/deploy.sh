#!/usr/bin/env bash
#
# TailorTeX — cloud deployment
#
# Cloud Run のコンパイルサービスをビルド・デプロイし、Firebase Hosting /
# Firestore ルールをデプロイする。開発マシンに Docker は不要(ビルドは
# Cloud Build 側で実行される)。
#
# 前提(詳細は cloud/DEPLOY.md):
#   - gcloud CLI / firebase CLI がインストール・ログイン済み
#   - 対象 GCP プロジェクトで Cloud Run / Cloud Build / Artifact Registry API 有効
#   - Firebase プロジェクト作成済み・Blaze プラン・Google 認証有効化済み
#
# 使い方:
#   ./cloud/deploy.sh <project-id> [region]
#
# 例:
#   ./cloud/deploy.sh my-firebase-proj asia-northeast1

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-asia-northeast1}"
SERVICE="word-latex-compile"

if [[ -z "$PROJECT_ID" ]]; then
  echo "使い方: ./cloud/deploy.sh <project-id> [region]" >&2
  exit 1
fi

# スクリプトの位置からリポジトリルートを解決
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$SCRIPT_DIR/compile-service"

echo "==> プロジェクト: $PROJECT_ID / リージョン: $REGION"

command -v gcloud >/dev/null 2>&1 || { echo "gcloud が見つかりません。DEPLOY.md 参照。" >&2; exit 1; }
command -v firebase >/dev/null 2>&1 || { echo "firebase CLI が見つかりません(npx firebase でも可)。" >&2; exit 1; }

IMAGE="gcr.io/${PROJECT_ID}/${SERVICE}:latest"

echo "==> [1/3] Cloud Build でコンテナをビルド(Docker 不要): $IMAGE"
gcloud builds submit "$SERVICE_DIR" \
  --project "$PROJECT_ID" \
  --tag "$IMAGE"

echo "==> [2/3] Cloud Run にデプロイ: $SERVICE"
# フェーズ10d: コスト最適化。コンパイルは CPU バウンドかつ直列前提のため
#   concurrency=1 でインスタンス内の並行実行を禁止し、min-instances=0 で無負荷時は
#   スケール to zero(課金ゼロ)。max-instances=2 で暴走課金を抑止。CPU ブーストは
#   コールドスタートを速めるが課金増につながるため無効化(--no-cpu-boost)。
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --concurrency=1 \
  --memory=1Gi \
  --cpu=1 \
  --timeout=120 \
  --no-cpu-boost \
  --set-env-vars "FIREBASE_PROJECT_ID=${PROJECT_ID}"

echo "==> [3/3] Firebase Hosting / Firestore ルールをデプロイ"
# .firebaserc のプレースホルダを上書きするため --project でIDを明示
firebase deploy \
  --project "$PROJECT_ID" \
  --only hosting,firestore:rules,firestore:indexes

echo "==> 完了。Hosting URL は上記出力を参照してください。"
echo "    superadmin 付与: cd cloud && FIREBASE_PROJECT_ID=$PROJECT_ID node scripts/set-admin.js <email> superadmin"
