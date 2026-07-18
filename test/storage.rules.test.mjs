/*
 * word-like-latex — test/storage.rules.test.mjs(Agent-Assets-Back / フェーズ19)
 *
 * Cloud Storage セキュリティルール(cloud/storage.rules)のユニットテスト。
 * @firebase/rules-unit-testing の Storage 対応 API を使用し node --test で実行。
 * Storage エミュレータ(port 9199)+ Firestore エミュレータ(port 8080)が必要
 * (storage.rules が firestore.get で docs/{docId}.access を参照するため)。
 *
 * 実行:
 *   npx firebase emulators:exec --only storage,firestore \
 *     "node --test test/storage.rules.test.mjs"
 *
 * 参照フォーマット契約(フロント public/js/assets.js と共有):
 *   Storage パス = docs/{docId}/assets/{sha256}.{ext}
 *   参照文字列   = asset:{docId}/{sha256}.{ext}
 *
 * 検証ケース:
 *   1. owner は資産を read / write できる
 *   2. editor は資産を read / write できる
 *   3. commenter は read 可 / write 不可
 *   4. viewer は read 可 / write 不可
 *   5. 非メンバーは read / write 不可
 *   6. 未認証は read / write 不可
 *   7. サイズ超過(50MB 以上)は owner でも write 不可
 *   8. 旧モデル(ownerUid / collaborators)のメンバーも read / write 可
 *   9. superadmin は非メンバーでも read / write 可
 */
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

// Storage ルールの firestore.get(クロスサービス参照)を成立させるには、テストの
// projectId が Storage バケットの project と一致している必要がある。emulators:exec が
// 設定する GCLOUD_PROJECT(--project の値)に合わせる。未設定時は demo- で始まる ID。
const PROJECT_ID =
  process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-wll';

// エミュレータ接続先(firebase.json と同じ: firestore 8080 / storage 9199)
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const ST_HOST = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199')
  .replace(/^https?:\/\//, '');
const [fsHost, fsPort] = FS_HOST.split(':');
const [stHost, stPort] = ST_HOST.split(':');

const SMALL = new Uint8Array([1, 2, 3, 4]);
// 資産パス: docs/{docId}/assets/{sha256}.{ext}
const assetPath = (docId, name = 'e3b0c44298fc1c149afbf4c8996fb924.png') =>
  `docs/${docId}/assets/${name}`;

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: fsHost,
      port: Number(fsPort),
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
    storage: {
      host: stHost,
      port: Number(stPort),
      rules: readFileSync(new URL('../cloud/storage.rules', import.meta.url), 'utf8'),
    },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

// ---- ヘルパ ----
function storageFor(uid, claims) {
  return testEnv.authenticatedContext(uid, claims).storage();
}
function unauthStorage() {
  return testEnv.unauthenticatedContext().storage();
}
// ルールを迂回して親 doc(access マップ)を Firestore に仕込む
async function seedDoc(docId, data) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'docs', docId), data);
  });
}
// ルールを迂回して資産オブジェクトを Storage に仕込む(read テスト用)
async function seedAsset(docId, name) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await c.storage().ref(assetPath(docId, name)).put(SMALL);
  });
}
// 操作
function writeAsset(storage, docId, bytes = SMALL, name) {
  return storage.ref(assetPath(docId, name)).put(bytes);
}
function readAsset(storage, docId, name) {
  // getDownloadURL は read 権限が必要(未許可は storage/unauthorized)
  return storage.ref(assetPath(docId, name)).getDownloadURL();
}

const accessDoc = (access) => ({
  access,
  memberUids: Object.keys(access),
  html: 'body',
  title: 'T',
});

test('1. owner は資産を read / write できる', async () => {
  await seedDoc('d1', accessDoc({ alice: 'owner' }));
  await seedAsset('d1');
  const alice = storageFor('alice');
  await assertSucceeds(writeAsset(alice, 'd1', SMALL, 'newkey.png'));
  await assertSucceeds(readAsset(alice, 'd1'));
});

test('2. editor は資産を read / write できる', async () => {
  await seedDoc('d2', accessDoc({ alice: 'owner', frank: 'editor' }));
  await seedAsset('d2');
  const frank = storageFor('frank');
  await assertSucceeds(writeAsset(frank, 'd2', SMALL, 'edit.png'));
  await assertSucceeds(readAsset(frank, 'd2'));
});

test('3. commenter は read 可 / write 不可', async () => {
  await seedDoc('d3', accessDoc({ alice: 'owner', erin: 'commenter' }));
  await seedAsset('d3');
  const erin = storageFor('erin');
  await assertSucceeds(readAsset(erin, 'd3'));
  await assertFails(writeAsset(erin, 'd3', SMALL, 'nope.png'));
});

test('4. viewer は read 可 / write 不可', async () => {
  await seedDoc('d4', accessDoc({ alice: 'owner', dave: 'viewer' }));
  await seedAsset('d4');
  const dave = storageFor('dave');
  await assertSucceeds(readAsset(dave, 'd4'));
  await assertFails(writeAsset(dave, 'd4', SMALL, 'nope.png'));
});

test('5. 非メンバーは read / write できない', async () => {
  await seedDoc('d5', accessDoc({ alice: 'owner' }));
  await seedAsset('d5');
  const mallory = storageFor('mallory');
  await assertFails(readAsset(mallory, 'd5'));
  await assertFails(writeAsset(mallory, 'd5', SMALL, 'evil.png'));
});

test('6. 未認証は read / write できない', async () => {
  await seedDoc('d6', accessDoc({ alice: 'owner' }));
  await seedAsset('d6');
  const anon = unauthStorage();
  await assertFails(readAsset(anon, 'd6'));
  await assertFails(writeAsset(anon, 'd6', SMALL, 'anon.png'));
});

test('7. サイズ超過(50MB 以上)は owner でも write 不可', { timeout: 120000 }, async () => {
  await seedDoc('d7', accessDoc({ alice: 'owner' }));
  const alice = storageFor('alice');
  // ちょうど上限(50MB)以上 → 拒否
  const tooBig = new Uint8Array(50 * 1024 * 1024 + 1);
  await assertFails(writeAsset(alice, 'd7', tooBig, 'big.pdf'));
});

test('8. 旧モデル(ownerUid / collaborators)のメンバーも read / write 可', async () => {
  await seedDoc('d8', {
    ownerUid: 'alice', collaborators: ['carol'], title: 'legacy',
  });
  await seedAsset('d8');
  const owner = storageFor('alice');
  const collab = storageFor('carol');
  await assertSucceeds(writeAsset(owner, 'd8', SMALL, 'owner.png'));
  await assertSucceeds(readAsset(collab, 'd8'));
  await assertSucceeds(writeAsset(collab, 'd8', SMALL, 'collab.png'));
});

test('9. superadmin は非メンバーでも read / write できる', async () => {
  await seedDoc('d9', accessDoc({ alice: 'owner' }));
  await seedAsset('d9');
  const admin = storageFor('root', { role: 'superadmin' });
  await assertSucceeds(readAsset(admin, 'd9'));
  await assertSucceeds(writeAsset(admin, 'd9', SMALL, 'admin.png'));
});
