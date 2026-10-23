// Run with `pnpm bench`. Each size seeds `size` posts, `size` comments and `size / 10` users.
import { Bench } from 'tinybench';
import { createDb } from '../src/index.ts';

type User = { id: string; email: string; name: string };
type Post = { id: string; authorId: string; title: string };
type Comment = { postId: string; n: number; body: string };

function makeDb() {
  return createDb<{ user: User; post: Post; comment: Comment }>()({
    user: { key: ['id'], unique: [['email']] },
    post: {
      key: ['id'],
      indexes: [['title']],
      refs: {
        author: {
          fields: ['authorId'],
          to: 'user',
          onDelete: 'cascade',
          onUpdate: 'cascade',
          inverse: 'posts',
        },
      },
    },
    comment: {
      key: ['postId', 'n'],
      refs: {
        post: {
          fields: ['postId'],
          to: 'post',
          onDelete: 'cascade',
          onUpdate: 'cascade',
          inverse: 'comments',
        },
      },
    },
  });
}

function fixture(size: number) {
  const users = Array.from({ length: size / 10 }, (_, i) => ({
    id: `u${i}`,
    email: `u${i}@example.com`,
    name: `User ${i}`,
  }));
  const posts = Array.from({ length: size }, (_, i) => ({
    id: `p${i}`,
    authorId: `u${i % users.length}`,
    title: `Title ${i % 100}`,
  }));
  const comments = Array.from({ length: size }, (_, i) => ({
    postId: `p${i % posts.length}`,
    n: i,
    body: 'Nice',
  }));
  return { user: users, post: posts, comment: comments };
}

const ROLLBACK = Symbol('rollback');

for (const size of [10_000, 100_000]) {
  const data = fixture(size);
  const db = makeDb();
  db.load(data);
  const seeded = db.snapshot();
  const users = size / 10;
  let i = 0;

  const rolledBack = (fn: () => void) => () => {
    try {
      db.transaction(() => {
        fn();
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }
  };

  const label = `${size.toLocaleString('en')} rows`;
  const perRow = new Bench({ name: `${label}: single operations`, time: 300 })
    .add('get', () => {
      db.post.get({ id: `p${i++ % size}` });
    })
    .add('where on a foreign key (10 rows)', () => {
      db.post.where({ authorId: `u${i++ % users}` });
    })
    .add('where on two indexes', () => {
      db.post.where({ title: `Title ${i++ % 100}`, authorId: `u${i % users}` });
    })
    .add('rel, inverse (10 rows)', () => {
      db.user.rel({ id: `u${i++ % users}` }, 'posts');
    })
    .add('insert', () => {
      db.comment.insert({ postId: `p${i % size}`, n: size + i++, body: 'Hi' });
    })
    .add('update a non-key field', () => {
      db.post.update({ id: `p${i++ % size}` }, { title: `Title ${i % 100}` });
    })
    .add(
      'key change, cascading (rolled back)',
      rolledBack(() => {
        const id = `p${i++ % size}`;
        db.post.update({ id }, { id: `${id}-renamed` });
      }),
    )
    .add(
      'delete, cascading to 10 posts + comments (rolled back)',
      rolledBack(() => db.user.delete({ id: `u${i++ % users}` })),
    );

  const whole = new Bench({ name: `${label}: whole database`, time: 0, iterations: 5 })
    .add('load', () => {
      makeDb().load(data);
    })
    .add('where with a full scan', () => {
      db.user.where({ name: `User ${i++ % users}` });
    })
    .add('snapshot', () => {
      db.snapshot();
    })
    .add('restore', () => {
      db.restore(seeded);
    });

  for (const bench of [perRow, whole]) {
    bench.runSync();
    console.log(`\n${bench.name}`);
    console.table(
      bench.tasks.map((task) => {
        const r = task.result;
        if (r.state !== 'completed') return { task: task.name, state: r.state };
        return {
          task: task.name,
          'ops/s': Math.round(r.throughput.mean).toLocaleString('en'),
          'mean (µs)': (r.latency.mean * 1000).toFixed(2),
          samples: r.latency.samplesCount,
        };
      }),
    );
  }
}
