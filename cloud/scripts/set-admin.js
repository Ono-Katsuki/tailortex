#!/usr/bin/env node
/*
 * TailorTeX — cloud administrator setup
 *
 * 指定メールアドレスのユーザに superadmin / user ロールを付与する。
 * Firebase の Custom Claims(`role`)を設定し、Firestore の users/{uid}.role も
 * 併せて更新する(管理コンソールが Firestore を直読みするため)。
 *
 * 使い方:
 *   node set-admin.js <email> superadmin|user
 *
 * 認証情報:
 *   - 本番: GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント鍵の JSON パス、
 *           もしくは `gcloud auth application-default login` の ADC を使う。
 *   - env FIREBASE_PROJECT_ID でプロジェクトIDを明示できる。
 *   - エミュレータ: FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST を設定。
 *
 * 例:
 *   FIREBASE_PROJECT_ID=my-proj GOOGLE_APPLICATION_CREDENTIALS=./sa.json \
 *     node cloud/scripts/set-admin.js you@example.com superadmin
 */
'use strict';

const admin = require('firebase-admin');

function usage(msg) {
  if (msg) console.error('エラー: ' + msg);
  console.error('使い方: node set-admin.js <email> superadmin|user');
  process.exit(1);
}

async function main() {
  const email = process.argv[2];
  const role = process.argv[3];

  if (!email || !email.includes('@')) usage('有効なメールアドレスを指定してください');
  if (role !== 'superadmin' && role !== 'user') usage('ロールは superadmin か user のみ');

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  admin.initializeApp({ projectId: projectId || undefined });

  const auth = admin.auth();
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (e) {
    usage(`ユーザが見つかりません(${email}): ${e.message}`);
    return;
  }

  // role==user のときは claim から role を除去、superadmin はセット
  const claims = role === 'superadmin' ? { role: 'superadmin' } : {};
  await auth.setCustomUserClaims(user.uid, claims);

  // Firestore の users/{uid}.role も更新(存在すればマージ)
  try {
    await admin.firestore().collection('users').doc(user.uid).set(
      { role: role, email: email }, { merge: true }
    );
  } catch (e) {
    console.warn('警告: Firestore users/' + user.uid + ' の更新に失敗: ' + e.message);
  }

  console.log(`OK: ${email} (uid=${user.uid}) のロールを "${role}" に設定しました。`);
  console.log('注意: 対象ユーザは次回サインイン(またはトークン更新)で反映されます。');
  process.exit(0);
}

main().catch((e) => {
  console.error('失敗:', e && e.message ? e.message : e);
  process.exit(1);
});
