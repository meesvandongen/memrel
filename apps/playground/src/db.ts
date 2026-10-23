import { createDb } from '@mvd/memrel';

export type User = { id: string; email: string; name: string };
export type Org = { id: number; name: string };
export type OrgUser = { orgId: number; userId: string; role: 'admin' | 'member' };
export type OrgUserPermission = { memberOrgId: number; memberUserId: string; permission: string };
export type Post = { id: string; authorId: string; reviewerId: string | null; title: string };

export function createPlaygroundDb() {
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
          onDelete: 'cascade',
          onUpdate: 'cascade',
          inverse: 'members',
        },
        user: {
          fields: ['userId'],
          to: 'user',
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
        author: { fields: ['authorId'], to: 'user', onDelete: 'restrict', inverse: 'posts' },
        reviewer: {
          fields: ['reviewerId'],
          to: 'user',
          onDelete: 'setNull',
          onUpdate: 'cascade',
          inverse: 'reviews',
        },
      },
    },
  });
}

export type PlaygroundDb = ReturnType<typeof createPlaygroundDb>;
export type CollectionName = 'user' | 'org' | 'orgUser' | 'orgUserPermission' | 'post';

export const seed = {
  user: [
    { id: 'u1', email: 'ann@acme.dev', name: 'Ann' },
    { id: 'u2', email: 'bob@acme.dev', name: 'Bob' },
    { id: 'u3', email: 'cleo@globex.dev', name: 'Cleo' },
  ],
  org: [
    { id: 1, name: 'Acme' },
    { id: 2, name: 'Globex' },
  ],
  orgUser: [
    { orgId: 1, userId: 'u1', role: 'admin' },
    { orgId: 1, userId: 'u2', role: 'member' },
    { orgId: 2, userId: 'u1', role: 'member' },
    { orgId: 2, userId: 'u3', role: 'admin' },
  ],
  orgUserPermission: [
    { memberOrgId: 1, memberUserId: 'u1', permission: 'billing' },
    { memberOrgId: 1, memberUserId: 'u1', permission: 'deploy' },
    { memberOrgId: 2, memberUserId: 'u1', permission: 'read' },
    { memberOrgId: 1, memberUserId: 'u2', permission: 'read' },
    { memberOrgId: 2, memberUserId: 'u3', permission: 'billing' },
  ],
  post: [
    { id: 'p1', authorId: 'u1', reviewerId: 'u3', title: 'Hello memrel' },
    { id: 'p2', authorId: 'u1', reviewerId: 'u2', title: 'Zod tips' },
    { id: 'p3', authorId: 'u2', reviewerId: 'u1', title: 'Composite keys 101' },
    { id: 'p4', authorId: 'u2', reviewerId: null, title: 'Cascades, explained' },
  ],
} as const;

export interface RefInfo {
  name: string;
  fields: string[];
  to: CollectionName;
  references: string[];
  onDelete: string;
  onUpdate: string;
  inverse?: string;
}

export interface CollectionInfo {
  name: CollectionName;
  fields: string[];
  key: string[];
  unique: string[][];
  refs: RefInfo[];
  /** Relation names usable with `rel`, forward refs and inverses. */
  rels: string[];
  blurb: string;
}

/** What the UI shows about each collection, mirroring the config above. */
export const collections: CollectionInfo[] = [
  {
    name: 'user',
    fields: ['id', 'email', 'name'],
    key: ['id'],
    unique: [['email']],
    refs: [],
    rels: ['memberships', 'posts', 'reviews'],
    blurb: 'Unique email besides the primary key.',
  },
  {
    name: 'org',
    fields: ['id', 'name'],
    key: ['id'],
    unique: [],
    refs: [],
    rels: ['members'],
    blurb: 'Numeric keys: 1 and "1" never collide.',
  },
  {
    name: 'orgUser',
    fields: ['orgId', 'userId', 'role'],
    key: ['orgId', 'userId'],
    unique: [],
    refs: [
      {
        name: 'org',
        fields: ['orgId'],
        to: 'org',
        references: ['id'],
        onDelete: 'cascade',
        onUpdate: 'cascade',
        inverse: 'members',
      },
      {
        name: 'user',
        fields: ['userId'],
        to: 'user',
        references: ['id'],
        onDelete: 'cascade',
        onUpdate: 'cascade',
        inverse: 'memberships',
      },
    ],
    rels: ['org', 'user', 'permissions'],
    blurb: 'Composite primary key.',
  },
  {
    name: 'orgUserPermission',
    fields: ['memberOrgId', 'memberUserId', 'permission'],
    key: ['memberOrgId', 'memberUserId', 'permission'],
    unique: [],
    refs: [
      {
        name: 'membership',
        fields: ['memberOrgId', 'memberUserId'],
        to: 'orgUser',
        references: ['orgId', 'userId'],
        onDelete: 'cascade',
        onUpdate: 'cascade',
        inverse: 'permissions',
      },
    ],
    rels: ['membership'],
    blurb: 'Composite foreign key into orgUser.',
  },
  {
    name: 'post',
    fields: ['id', 'authorId', 'reviewerId', 'title'],
    key: ['id'],
    unique: [],
    refs: [
      {
        name: 'author',
        fields: ['authorId'],
        to: 'user',
        references: ['id'],
        onDelete: 'restrict',
        onUpdate: 'restrict',
        inverse: 'posts',
      },
      {
        name: 'reviewer',
        fields: ['reviewerId'],
        to: 'user',
        references: ['id'],
        onDelete: 'setNull',
        onUpdate: 'cascade',
        inverse: 'reviews',
      },
    ],
    rels: ['author', 'reviewer'],
    blurb: 'Indexed by title. Authors restrict deletes; reviewers are set to null.',
  },
];

export const collectionInfo = new Map(collections.map((c) => [c.name, c]));

/** A stable string for a row's primary key, used to track rows across renders. */
export function rowKey(info: CollectionInfo, row: object): string {
  const r = row as Record<string, unknown>;
  return JSON.stringify(info.key.map((f) => r[f]));
}
