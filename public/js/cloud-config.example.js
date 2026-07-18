/* cloud-config.example.js — クラウド設定テンプレート(フェーズ7)
 *
 * 使い方:
 *   1. このファイルを public/js/cloud-config.js にコピーする(cloud-config.js は
 *      gitignore 済み。無ければ store.js はローカルモードのままで挙動不変)。
 *   2. Firebase コンソールの「ウェブアプリの設定」から取得した値で下記を埋める。
 *   3. デプロイ手順は cloud/DEPLOY.md を参照。
 *
 * store.js は window.FIREBASE_CONFIG が「オブジェクトで、かつ apiKey / projectId /
 * useEmulator のいずれかを持つ」場合だけクラウドモードを有効化し、その時だけ
 * vendor/firebase/*-compat.js を動的ロードします。
 * 未設定(null / 空)ならローカルモードのまま(Firebase SDK も読みません)。
 */

/* ---------- 本番 / ステージング用の例 ---------- */
// window.FIREBASE_CONFIG = {
//   apiKey: 'AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
//   authDomain: 'your-project-id.firebaseapp.com',
//   projectId: 'your-project-id',
//   storageBucket: 'your-project-id.appspot.com',
//   messagingSenderId: '000000000000',
//   appId: '1:000000000000:web:xxxxxxxxxxxxxxxx',
//
//   // 任意: vendor firebase compat の配置先(既定 'vendor/firebase/')
//   // vendorBase: 'vendor/firebase/',
//
//   // 任意: 管理 API(Cloud Run)のベース URL(/admin/users を叩く)
//   // adminApiBase: 'https://your-region-your-project.a.run.app',
//
//   // 任意: コンパイルサービス(Cloud Run)の URL
//   // compileUrl: 'https://your-region-your-project.a.run.app',
// };

/* ---------- ローカルのエミュレータで検証する例 ----------
 * `firebase emulators:start --only auth,firestore` を起動してから使用。
 * useEmulator: true で auth(127.0.0.1:9099)と firestore(127.0.0.1:8080)へ接続する。
 * projectId はエミュレータ用のダミーで良い(.firebaserc / firebase.json と一致させる)。
 */
window.FIREBASE_CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'demo-word-latex.firebaseapp.com',
  projectId: 'demo-word-latex',
  appId: 'demo-app',
  useEmulator: true
};
