export interface Scenario {
  id: string;
  group: 'Read' | 'Write' | 'Integrity' | 'Cascades' | 'Safety nets';
  title: string;
  /** What to look at once it ran. */
  explain: string;
  code: string;
}

export const scenarios: Scenario[] = [
  {
    id: 'query',
    group: 'Read',
    title: 'Look up, search and traverse',
    explain:
      '`get` needs the complete key, `where` uses indexes (here the foreign key on authorId and the title index), and `rel` follows relations in both directions.',
    code: `const ann = db.user.get({ id: 'u1' });

return {
  ann,
  posts: db.user.rel(ann, 'posts').map((p) => p.title),
  orgs: db.user.rel(ann, 'memberships').map((m) => db.orgUser.rel(m, 'org').name),
  byBob: db.post.where({ authorId: 'u2' }).length,
  titled: db.post.where({ title: { in: ['Zod tips', 'Hello memrel'] } }).map((p) => p.id),
};`,
  },
  {
    id: 'composite',
    group: 'Read',
    title: 'Composite keys',
    explain:
      'orgUser has a composite primary key, and its permissions point at it through a composite foreign key. `rel` resolves them from just the key.',
    code: `const membership = db.orgUser.get({ orgId: 1, userId: 'u1' });

return {
  membership,
  permissions: db.orgUser.rel({ orgId: 1, userId: 'u1' }, 'permissions')
    .map((p) => p.permission),
  acmeMembers: db.org.rel({ id: 1 }, 'members').map((m) => db.orgUser.rel(m, 'user').name),
};`,
  },
  {
    id: 'insert',
    group: 'Write',
    title: 'Insert a batch in any order',
    explain:
      'References are checked once the whole batch is in, so the post can come before the user it points at. `load` takes the shape of a JSON fixture file.',
    code: `db.load({
  post: [{ id: 'p5', authorId: 'u4', reviewerId: 'u1', title: 'Fixtures that just work' }],
  user: [{ id: 'u4', email: 'dee@acme.dev', name: 'Dee' }],
  orgUser: [{ orgId: 1, userId: 'u4', role: 'member' }],
});

return db.user.rel({ id: 'u4' }, 'posts');`,
  },
  {
    id: 'update',
    group: 'Write',
    title: 'Update rows',
    explain:
      'Patch one key, several keys, or derive the patch from the current row. Rows are replaced, never mutated, so earlier results stay unchanged.',
    code: `const before = db.post.get({ id: 'p1' });

db.post.update(db.post.where({ authorId: 'u1' }), (p) => ({ title: p.title.toUpperCase() }));

return { before: before.title, after: db.post.get({ id: 'p1' }).title };`,
  },
  {
    id: 'upsert',
    group: 'Write',
    title: 'Upsert with onConflict',
    explain:
      "`onConflict: 'replace'` replaces the whole row (PUT semantics) without cascading anything away; `'ignore'` keeps existing rows.",
    code: `db.user.insert({ id: 'u2', email: 'robert@acme.dev', name: 'Robert' }, { onConflict: 'replace' });
db.user.insert(
  [
    { id: 'u1', email: 'ignored@acme.dev', name: 'Ignored' },
    { id: 'u5', email: 'eve@acme.dev', name: 'Eve' },
  ],
  { onConflict: 'ignore' },
);

return db.user.where({}).map((u) => u.name);`,
  },
  {
    id: 'dangling',
    group: 'Integrity',
    title: 'Dangling references are rejected',
    explain: 'post.author must point at an existing user. The failed insert changes nothing.',
    code: `db.post.insert({ id: 'p9', authorId: 'ghost', reviewerId: null, title: 'Boo' });`,
  },
  {
    id: 'unique',
    group: 'Integrity',
    title: 'Unique keys',
    explain: "user.email is a unique key, so a second user with Ann's email is rejected.",
    code: `db.user.insert({ id: 'u9', email: 'ann@acme.dev', name: 'Not Ann' });`,
  },
  {
    id: 'restrict',
    group: 'Integrity',
    title: 'restrict blocks a delete',
    explain:
      'post.author is `restrict`: Ann still has posts, so she cannot be deleted on her own. Nothing changes.',
    code: `return db.user.delete({ id: 'u1' });`,
  },
  {
    id: 'cascade-delete',
    group: 'Cascades',
    title: 'Delete with cascades',
    explain:
      'Deleting Ann together with her posts satisfies `restrict`, because it is checked against the whole plan. Her memberships cascade, then their permissions through the composite foreign key. Her reviews are set to null.',
    code: `const { deleted, nulled } = db.remove({
  user: [{ id: 'u1' }],
  post: db.post.where({ authorId: 'u1' }),
});

return {
  deleted: Object.fromEntries(Object.entries(deleted).map(([name, rows]) => [name, rows.length])),
  nulled,
};`,
  },
  {
    id: 'set-null',
    group: 'Cascades',
    title: 'setNull',
    explain:
      'post.reviewer is `setNull`: deleting Cleo clears the reviewer of the posts she reviewed, and cascades away her memberships.',
    code: `return db.user.delete({ id: 'u3' });`,
  },
  {
    id: 'rename',
    group: 'Cascades',
    title: 'Change a key, cascade the change',
    explain:
      "Keys can change. Renaming org 1 rewrites orgUser.orgId, which changes orgUser's primary key, which rewrites orgUserPermission.memberOrgId.",
    code: `db.org.update({ id: 1 }, { id: 100 });

return db.org.rel({ id: 100 }, 'members').map((m) => ({
  member: m.userId,
  permissions: db.orgUser.rel(m, 'permissions').map((p) => p.permission),
}));`,
  },
  {
    id: 'rename-restrict',
    group: 'Cascades',
    title: 'Renaming a user',
    explain:
      'post.author has the default `onUpdate: restrict`, so Bob can only get a new id once his posts are moved. Inside a transaction, the posts move and the rename cascades through memberships, permissions and reviews.',
    code: `db.transaction(() => {
  db.user.insert({ id: 'u-temp', email: 'temp@acme.dev', name: 'Temp' });
  const posts = db.post.where({ authorId: 'u2' });
  db.post.update(posts, { authorId: 'u-temp' });
  db.user.update({ id: 'u2' }, { id: 'bob' });
  db.post.update(posts, { authorId: 'bob' });
  db.user.delete({ id: 'u-temp' });
});

return db.user.rel({ id: 'bob' }, 'memberships');`,
  },
  {
    id: 'transaction',
    group: 'Safety nets',
    title: 'Transactions roll back',
    explain:
      'Any throw inside `transaction` rolls back every change made inside it, including the insert and the cascading delete.',
    code: `try {
  db.transaction(() => {
    db.user.insert({ id: 'u9', email: 'dan@acme.dev', name: 'Dan' });
    db.org.delete({ id: 2 });
    log('inside:', db.org.where({}).length, 'orgs');
    throw new Error('Changed my mind');
  });
} catch (error) {
  log(error.message);
}

return { orgs: db.org.where({}).length, dan: db.user.get({ id: 'u9' }) ?? null };`,
  },
  {
    id: 'snapshot',
    group: 'Safety nets',
    title: 'Snapshot and restore',
    explain:
      'Take a snapshot, do damage, restore. Tests seed once and restore before each test. The Undo button above uses the same mechanism.',
    code: `const seeded = db.snapshot();

db.org.delete([{ id: 1 }, { id: 2 }]);
const afterDelete = db.orgUser.where({}).length;

db.restore(seeded);

return { afterDelete, afterRestore: db.orgUser.where({}).length };`,
  },
];
