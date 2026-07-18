/*
 * word-like-latex — test/rules.test.mjs (Agent-Cloud-Back / フェーズ7)
 *
 * Firestore セキュリティルールのユニットテスト(@firebase/rules-unit-testing)。
 * node --test で実行。Firestore エミュレータ(port 8080)が必要。
 *
 * 実行:
 *   npx firebase emulators:exec --only firestore \
 *     "node --test test/rules.test.mjs"
 * もしくは:
 *   npm run test:rules
 *
 * 検証ケース(SPEC の受け入れ基準に対応):
 *   1. owner は自分の docs を read/write できる
 *   2. 他人は他人の docs を read できない
 *   3. 他人は他人の docs を write できない
 *   4. collaborator は docs を read/write できる
 *   5. superadmin クレームは他人の docs を read/write/delete できる
 *   6. users/{uid} は本人のみ read できる(他人は不可)
 *   7. 一般ユーザーは adminLogs を read できない
 *   8. superadmin は adminLogs を read できる
 *   9. 未認証は docs を read できない
 *  10. shares は誰でも read / owner のみ write
 *
 * フェーズ14 / 13b(ユーザー単位の権限 + コメント権限):
 *  11. viewer は read 可 / 本文 write 不可
 *  12. commenter は本文 write 不可 / comments write 可
 *  12b. viewer は comments read 可 / write 不可
 *  13. editor は本文 write 可 / access 変更不可
 *  14. owner は access 変更可
 *  15. 非メンバーは read/write/comments 不可
 *  16. superadmin は access doc / comments 全権
 *  17. invites は招待本人 + doc owner のみ read
 *  18. invites は doc owner のみ create
 *  19. 招待本人は自分宛 invite を delete 可
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
} from 'firebase/firestore';

const PROJECT_ID = 'wll-rules-test';
let testEnv;

// エミュレータ接続先(firebase.json と同じ 8080)
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const [emuHost, emuPort] = HOST.split(':');

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: emuHost,
      port: Number(emuPort),
      rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});
after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// 認証コンテキストの生成ヘルパ
function ctx(uid, claims) {
  return testEnv.authenticatedContext(uid, claims).firestore();
}
function unauth() {
  return testEnv.unauthenticatedContext().firestore();
}

// ルールを迂回してテストデータを仕込む
async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (c) => {
    await fn(c.firestore());
  });
}

test('1. owner は自分の docs を read/write できる', async () => {
  await seed((db) => setDoc(doc(db, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A', collaborators: [],
  }));
  const alice = ctx('alice');
  await assertSucceeds(getDoc(doc(alice, 'docs', 'd1')));
  await assertSucceeds(setDoc(doc(alice, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A2', collaborators: [],
  }));
});

test('2. 他人は他人の docs を read できない', async () => {
  await seed((db) => setDoc(doc(db, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A', collaborators: [],
  }));
  const bob = ctx('bob');
  await assertFails(getDoc(doc(bob, 'docs', 'd1')));
});

test('3. 他人は他人の docs を write できない', async () => {
  await seed((db) => setDoc(doc(db, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A', collaborators: [],
  }));
  const bob = ctx('bob');
  await assertFails(setDoc(doc(bob, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'hacked', collaborators: [],
  }));
});

test('4. collaborator は docs を read/write できる', async () => {
  await seed((db) => setDoc(doc(db, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A', collaborators: ['carol'],
  }));
  const carol = ctx('carol');
  await assertSucceeds(getDoc(doc(carol, 'docs', 'd1')));
  await assertSucceeds(setDoc(doc(carol, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'edited', collaborators: ['carol'],
  }));
});

test('5. superadmin は他人の docs を read/write/delete できる', async () => {
  await seed((db) => setDoc(doc(db, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A', collaborators: [],
  }));
  const admin = ctx('root', { role: 'superadmin' });
  await assertSucceeds(getDoc(doc(admin, 'docs', 'd1')));
  await assertSucceeds(setDoc(doc(admin, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'admin-edit', collaborators: [],
  }));
  await assertSucceeds(deleteDoc(doc(admin, 'docs', 'd1')));
});

test('6. users/{uid} は本人のみ read できる(他人は不可)', async () => {
  await seed((db) => setDoc(doc(db, 'users', 'alice'), {
    email: 'alice@example.com', role: 'user',
  }));
  const alice = ctx('alice');
  const bob = ctx('bob');
  await assertSucceeds(getDoc(doc(alice, 'users', 'alice')));
  await assertFails(getDoc(doc(bob, 'users', 'alice')));
});

test('6b. users 本人は role を自己昇格できない / profile 更新は可', async () => {
  await seed((db) => setDoc(doc(db, 'users', 'alice'), {
    email: 'alice@example.com', role: 'user',
  }));
  const alice = ctx('alice');
  // profile 更新(displayName)は許可
  await assertSucceeds(setDoc(doc(alice, 'users', 'alice'),
    { displayName: 'Alice' }, { merge: true }));
  // role を superadmin に自己昇格は拒否
  await assertFails(setDoc(doc(alice, 'users', 'alice'),
    { role: 'superadmin' }, { merge: true }));
});

test('7. 一般ユーザーは adminLogs を read できない', async () => {
  await seed((db) => setDoc(doc(db, 'adminLogs', 'l1'), {
    action: 'listUsers', actorUid: 'root',
  }));
  const bob = ctx('bob');
  await assertFails(getDoc(doc(bob, 'adminLogs', 'l1')));
  // クライアントからの adminLogs write も拒否
  await assertFails(setDoc(doc(bob, 'adminLogs', 'l2'), { action: 'x' }));
});

test('8. superadmin は adminLogs を read できる', async () => {
  await seed((db) => setDoc(doc(db, 'adminLogs', 'l1'), {
    action: 'listUsers', actorUid: 'root',
  }));
  const admin = ctx('root', { role: 'superadmin' });
  await assertSucceeds(getDoc(doc(admin, 'adminLogs', 'l1')));
});

test('9. 未認証ユーザーは docs を read できない', async () => {
  await seed((db) => setDoc(doc(db, 'docs', 'd1'), {
    ownerUid: 'alice', title: 'A', collaborators: [],
  }));
  const anon = unauth();
  await assertFails(getDoc(doc(anon, 'docs', 'd1')));
});

test('10. shares は誰でも read できる / owner のみ write', async () => {
  await seed((db) => setDoc(doc(db, 'shares', 's1'), {
    ownerUid: 'alice', title: 'shared',
  }));
  const anon = unauth();
  await assertSucceeds(getDoc(doc(anon, 'shares', 's1')));
  // 他人は更新不可
  const bob = ctx('bob');
  await assertFails(setDoc(doc(bob, 'shares', 's1'),
    { ownerUid: 'alice', title: 'hijack' }, { merge: true }));
});

// ---------------------------------------------------------------------------
// フェーズ14 / 13b: ユーザー単位の権限(access マップ)+ コメント権限
//   docs.access = { uid: "owner"|"editor"|"commenter"|"viewer" }
//   memberUids  = [uid...]
//   本文(html 等)と comments を分離: docs/{docId}/comments/{cid}
// ---------------------------------------------------------------------------

// 新モデルの docs をルール迂回で仕込むヘルパ
function seedAccessDoc(id, access, extra) {
  const memberUids = Object.keys(access);
  return seed((db) => setDoc(doc(db, 'docs', id), Object.assign({
    access, memberUids, html: 'body', title: 'T',
  }, extra || {})));
}

test('11. viewer は access doc を read できる / 本文 write は不可', async () => {
  await seedAccessDoc('a1', { alice: 'owner', dave: 'viewer' });
  const dave = ctx('dave');
  await assertSucceeds(getDoc(doc(dave, 'docs', 'a1')));
  // 本文 write は拒否(access/memberUids は据え置きでも viewer は不可)
  await assertFails(setDoc(doc(dave, 'docs', 'a1'), {
    access: { alice: 'owner', dave: 'viewer' }, memberUids: ['alice', 'dave'],
    html: 'hacked', title: 'T',
  }));
});

test('12. commenter は本文 write 不可 / comments は write 可', async () => {
  await seedAccessDoc('a2', { alice: 'owner', erin: 'commenter' });
  const erin = ctx('erin');
  // read は可
  await assertSucceeds(getDoc(doc(erin, 'docs', 'a2')));
  // 本文 write は拒否
  await assertFails(setDoc(doc(erin, 'docs', 'a2'), {
    access: { alice: 'owner', erin: 'commenter' }, memberUids: ['alice', 'erin'],
    html: 'edited', title: 'T',
  }));
  // comments サブコレクションへの write は許可
  await assertSucceeds(setDoc(doc(erin, 'docs', 'a2', 'comments', 'c1'), {
    author: 'erin', text: 'nice paragraph', ts: 1,
  }));
});

test('12b. viewer は comments を read 可 / write 不可', async () => {
  await seedAccessDoc('a2b', { alice: 'owner', dave: 'viewer' });
  await seed((db) => setDoc(doc(db, 'docs', 'a2b', 'comments', 'c0'), {
    author: 'alice', text: 'hi', ts: 1,
  }));
  const dave = ctx('dave');
  await assertSucceeds(getDoc(doc(dave, 'docs', 'a2b', 'comments', 'c0')));
  await assertFails(setDoc(doc(dave, 'docs', 'a2b', 'comments', 'c9'), {
    author: 'dave', text: 'blocked', ts: 2,
  }));
});

test('13. editor は本文 write 可 / access 変更は不可', async () => {
  await seedAccessDoc('a3', { alice: 'owner', frank: 'editor' });
  const frank = ctx('frank');
  // 本文編集(access/memberUids 据え置き)は許可
  await assertSucceeds(setDoc(doc(frank, 'docs', 'a3'), {
    access: { alice: 'owner', frank: 'editor' }, memberUids: ['alice', 'frank'],
    html: 'frank edit', title: 'T2',
  }));
  // access を書き換える(自己昇格)更新は拒否
  await assertFails(setDoc(doc(frank, 'docs', 'a3'), {
    access: { alice: 'owner', frank: 'owner' }, memberUids: ['alice', 'frank'],
    html: 'frank edit', title: 'T2',
  }));
  // memberUids を書き換える更新も拒否
  await assertFails(setDoc(doc(frank, 'docs', 'a3'), {
    access: { alice: 'owner', frank: 'editor' }, memberUids: ['alice', 'frank', 'mallory'],
    html: 'frank edit', title: 'T2',
  }));
});

test('14. owner は access を変更できる(招待の反映)', async () => {
  await seedAccessDoc('a4', { alice: 'owner' });
  const alice = ctx('alice');
  await assertSucceeds(setDoc(doc(alice, 'docs', 'a4'), {
    access: { alice: 'owner', gina: 'editor' }, memberUids: ['alice', 'gina'],
    html: 'body', title: 'T',
  }));
});

test('15. 非メンバーは access doc を read/write できない', async () => {
  await seedAccessDoc('a5', { alice: 'owner' });
  const mallory = ctx('mallory');
  await assertFails(getDoc(doc(mallory, 'docs', 'a5')));
  await assertFails(setDoc(doc(mallory, 'docs', 'a5'), {
    access: { alice: 'owner' }, memberUids: ['alice'], html: 'x', title: 'T',
  }));
  // comments も不可
  await assertFails(setDoc(doc(mallory, 'docs', 'a5', 'comments', 'c1'), {
    author: 'mallory', text: 'x', ts: 1,
  }));
});

test('16. superadmin は access doc / comments に全権', async () => {
  await seedAccessDoc('a6', { alice: 'owner' });
  const admin = ctx('root', { role: 'superadmin' });
  await assertSucceeds(getDoc(doc(admin, 'docs', 'a6')));
  await assertSucceeds(setDoc(doc(admin, 'docs', 'a6'), {
    access: { alice: 'owner', root: 'editor' }, memberUids: ['alice', 'root'],
    html: 'admin', title: 'T',
  }));
  await assertSucceeds(setDoc(doc(admin, 'docs', 'a6', 'comments', 'c1'), {
    author: 'root', text: 'admin comment', ts: 1,
  }));
  await assertSucceeds(deleteDoc(doc(admin, 'docs', 'a6')));
});

test('17. invites は招待本人のみ read できる(owner も read 可)', async () => {
  await seedAccessDoc('a7', { alice: 'owner' });
  await seed((db) => setDoc(doc(db, 'invites', 'inv7'), {
    docId: 'a7', email: 'invitee@example.com', role: 'editor', invitedBy: 'alice',
  }));
  // 招待本人(token.email 一致)は read できる
  const invitee = ctx('u-invitee', { email: 'invitee@example.com' });
  await assertSucceeds(getDoc(doc(invitee, 'invites', 'inv7')));
  // 別メールのユーザーは read できない
  const other = ctx('u-other', { email: 'other@example.com' });
  await assertFails(getDoc(doc(other, 'invites', 'inv7')));
  // doc の owner は自分の doc の invite を read できる
  const alice = ctx('alice');
  await assertSucceeds(getDoc(doc(alice, 'invites', 'inv7')));
});

test('18. invites は doc の owner のみ create できる', async () => {
  await seedAccessDoc('a8', { alice: 'owner' });
  const alice = ctx('alice');
  await assertSucceeds(setDoc(doc(alice, 'invites', 'inv8'), {
    docId: 'a8', email: 'new@example.com', role: 'viewer', invitedBy: 'alice',
  }));
  // 非owner(メンバーですらない)は create できない
  const bob = ctx('bob');
  await assertFails(setDoc(doc(bob, 'invites', 'inv8b'), {
    docId: 'a8', email: 'evil@example.com', role: 'editor', invitedBy: 'bob',
  }));
});

test('19. 招待本人は自分宛 invite を delete できる(回収後クリーンアップ)', async () => {
  await seedAccessDoc('a9', { alice: 'owner' });
  await seed((db) => setDoc(doc(db, 'invites', 'inv9'), {
    docId: 'a9', email: 'invitee@example.com', role: 'editor', invitedBy: 'alice',
  }));
  // 別メールユーザーは delete 不可
  const other = ctx('u-other', { email: 'other@example.com' });
  await assertFails(deleteDoc(doc(other, 'invites', 'inv9')));
  // 招待本人は delete 可
  const invitee = ctx('u-invitee', { email: 'invitee@example.com' });
  await assertSucceeds(deleteDoc(doc(invitee, 'invites', 'inv9')));
});

test('20. doc owner は招待を delete できる(取り消し)', async () => {
  await seedAccessDoc('a10', { alice: 'owner' });
  await seed((db) => setDoc(doc(db, 'invites', 'inv10'), {
    docId: 'a10', email: 'invitee@example.com', role: 'editor', invitedBy: 'alice',
  }));
  const alice = ctx('alice');
  await assertSucceeds(getDoc(doc(alice, 'invites', 'inv10')));
  await assertSucceeds(deleteDoc(doc(alice, 'invites', 'inv10')));
  // 非owner・非招待者は delete 不可
  await seed((db) => setDoc(doc(db, 'invites', 'inv10'), {
    docId: 'a10', email: 'invitee@example.com', role: 'editor', invitedBy: 'alice',
  }));
  const bob = ctx('bob');
  await assertFails(deleteDoc(doc(bob, 'invites', 'inv10')));
});
