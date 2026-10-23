import { createDb } from '../src/index.ts';

export type User = { id: string; email: string; name: string };
export type Org = { id: number; name: string };
export type OrgUser = { orgId: number; userId: string; role: 'admin' | 'member' };
export type OrgUserPermission = { memberOrgId: number; memberUserId: string; permission: string };
export type Post = { id: string; authorId: string; title: string };

/** The schema from the design document. */
export function makeDb() {
  return createDb<{
    user: User;
    org: Org;
    orgUser: OrgUser;
    orgUserPermission: OrgUserPermission;
    post: Post;
  }>()({
    user: { key: ['id'], unique: [['email']] },
    org: { key: ['id'] },
    orgUser: {
      key: ['orgId', 'userId'],
      refs: {
        org: {
          fields: ['orgId'],
          to: 'org',
          references: ['id'],
          onDelete: 'cascade',
          onUpdate: 'cascade',
          inverse: 'members',
        },
        user: {
          fields: ['userId'],
          to: 'user',
          references: ['id'],
          onDelete: 'cascade',
          onUpdate: 'cascade',
          inverse: 'memberships',
        },
      },
    },
    orgUserPermission: {
      key: ['memberOrgId', 'memberUserId', 'permission'],
      refs: {
        membership: {
          fields: ['memberOrgId', 'memberUserId'],
          to: 'orgUser',
          references: ['orgId', 'userId'],
          onDelete: 'cascade',
          onUpdate: 'cascade',
          inverse: 'permissions',
        },
      },
    },
    post: {
      key: ['id'],
      indexes: [['title']],
      refs: {
        author: {
          fields: ['authorId'],
          to: 'user',
          references: ['id'],
          onDelete: 'restrict',
          inverse: 'posts',
        },
      },
    },
  });
}

export const seed = {
  user: [
    { id: 'u1', email: 'ann@example.com', name: 'Ann' },
    { id: 'u2', email: 'bob@example.com', name: 'Bob' },
  ],
  org: [
    { id: 1, name: 'Acme' },
    { id: 2, name: 'Globex' },
  ],
  orgUser: [
    { orgId: 1, userId: 'u1', role: 'admin' },
    { orgId: 1, userId: 'u2', role: 'member' },
    { orgId: 2, userId: 'u1', role: 'member' },
  ],
  orgUserPermission: [
    { memberOrgId: 1, memberUserId: 'u1', permission: 'billing' },
    { memberOrgId: 1, memberUserId: 'u1', permission: 'admin' },
    { memberOrgId: 2, memberUserId: 'u1', permission: 'read' },
    { memberOrgId: 1, memberUserId: 'u2', permission: 'read' },
  ],
  post: [
    { id: 'p1', authorId: 'u1', title: 'Hello' },
    { id: 'p2', authorId: 'u1', title: 'Zod tips' },
    { id: 'p3', authorId: 'u2', title: 'Hello' },
  ],
} as const;

export function seededDb() {
  const db = makeDb();
  db.load(seed);
  return db;
}
