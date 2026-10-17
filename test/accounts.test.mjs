import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  accountStateDir,
  assertFolderName,
  createAccountStore,
  ensureAccountWorkspace,
  normalizeAccounts,
  resolveAccountWorkspace,
} from '../src/accounts.mjs'

test('account configuration rejects duplicate IDs', () => {
  assert.throws(
    () => normalizeAccounts({
      stateDir: '/tmp/dsh-weixin',
      accounts: [
        { id: 'primary', cwd: '/tmp/primary' },
        { id: 'primary', cwd: '/tmp/duplicate' },
      ],
    }),
    /重复/,
  )
})

test('account IDs cannot escape their state directory', () => {
  for (const id of ['', '.', '..', '../other', 'a/b', 'a\\b']) {
    assert.throws(
      () => accountStateDir('/tmp/dsh-weixin', id),
      /账号 ID/,
      `应拒绝不安全账号 ID：${JSON.stringify(id)}`,
    )
  }

  const dir = accountStateDir('/tmp/dsh-weixin', 'family-2')
  assert.equal(dir, path.resolve('/tmp/dsh-weixin/accounts/family-2'))
})

test('account IDs reject route names and case-insensitive duplicates', () => {
  for (const id of ['status', 'login', 'send', 'qr.svg', 'CON', 'name.']) {
    assert.throws(
      () => accountStateDir('/tmp/dsh-weixin', id),
      /账号 ID/,
      `应拒绝保留或不安全的账号 ID：${JSON.stringify(id)}`,
    )
  }
  assert.throws(
    () => normalizeAccounts({
      stateDir: '/tmp/dsh-weixin',
      accounts: [{ id: 'Primary' }, { id: 'primary' }],
    }),
    /重复/,
  )
})

test('default account resolves to the configured account spelling', () => {
  const normalized = normalizeAccounts({
    stateDir: '/tmp/dsh-weixin',
    defaultAccount: 'PRIMARY',
    accounts: [{ id: 'primary' }, { id: 'family' }],
  })
  assert.equal(normalized.defaultAccountId, 'primary')
})

test('accountRoot and folder resolve to isolated direct-child directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-folders-'))
  try {
    const normalized = normalizeAccounts({
      stateDir: path.join(root, 'state'),
      accountRoot: root,
      accounts: [
        { id: 'primary', folder: 'alice' },
        { id: 'family', folder: '家庭' },
      ],
    })
    assert.equal(normalized.accountRoot, path.resolve(root))
    assert.deepEqual(
      normalized.accounts.map(({ folder, cwd }) => ({ folder, cwd })),
      [
        { folder: 'alice', cwd: path.join(root, 'alice') },
        { folder: '家庭', cwd: path.join(root, '家庭') },
      ],
    )
    ensureAccountWorkspace(root, 'alice')
    ensureAccountWorkspace(root, '家庭')
    assert.equal(fs.statSync(path.join(root, 'alice')).isDirectory(), true)
    assert.equal(fs.statSync(path.join(root, '家庭')).isDirectory(), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('folder names cannot contain paths or escape accountRoot', () => {
  for (const folder of ['', '.', '..', '../other', 'a/b', 'a\\b', 'C:', 'bad\u0000name', 'CON', 'name.']) {
    assert.throws(
      () => assertFolderName(folder),
      /文件夹名/,
      `应拒绝不安全文件夹名：${JSON.stringify(folder)}`,
    )
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-folder-root-'))
  try {
    assert.equal(resolveAccountWorkspace(root, 'alice'), path.join(root, 'alice'))
    assert.throws(() => resolveAccountWorkspace(root, '../outside'), /文件夹名/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('accounts cannot share a workspace and legacy cwd derives folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-folder-duplicate-'))
  try {
    const normalized = normalizeAccounts({
      stateDir: path.join(root, 'state'),
      accounts: [
        { id: 'primary', cwd: path.join(root, 'alice') },
        { id: 'family', cwd: path.join(root, 'bob') },
      ],
    })
    assert.equal(normalized.accountRoot, path.resolve(root))
    assert.deepEqual(normalized.accounts.map((account) => account.folder), ['alice', 'bob'])
    assert.throws(
      () => normalizeAccounts({
        stateDir: path.join(root, 'state'),
        accountRoot: root,
        accounts: [
          { id: 'primary', folder: 'same' },
          { id: 'family', folder: 'same' },
        ],
      }),
      /同一个工作目录/,
    )
    assert.throws(
      () => normalizeAccounts({
        stateDir: path.join(root, 'state'),
        accountRoot: root,
        accounts: [{
          id: 'primary',
          folder: 'alice',
          cwd: path.join(root, 'bob'),
        }],
      }),
      /指向不同目录/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('configured account without folder stays unbound until one is supplied', () => {
  const normalized = normalizeAccounts({
    stateDir: '/tmp/dsh-weixin-empty-folder',
    accountRoot: '/tmp/dsh-account-root',
    accounts: [{ id: 'new-account' }],
  })
  assert.equal(normalized.accounts[0].folder, '')
  assert.equal(normalized.accounts[0].cwd, '')
})

test('account folder cannot be a symlink escape', () => {
  if (process.platform === 'win32') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-folder-link-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-folder-outside-'))
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')
    assert.throws(() => ensureAccountWorkspace(root, 'escape'), /符号链接/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('legacy single-account state migrates once into the default account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-accounts-'))
  try {
    fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ bot_token: 'legacy-token' }))
    fs.writeFileSync(path.join(root, 'session-map.json'), JSON.stringify({ 'user@im.wechat': 'session-legacy' }))
    fs.writeFileSync(path.join(root, 'updates-buf.json'), JSON.stringify({ buf: 'cursor-legacy' }))

    const store = createAccountStore(root, 'default', { migrateLegacy: true })
    assert.equal(store.loadCredentials().bot_token, 'legacy-token')
    assert.deepEqual(store.loadSessionMap(), { 'user@im.wechat': 'session-legacy' })
    assert.equal(store.loadBuf(), 'cursor-legacy')
    if (process.platform !== 'win32') {
      assert.equal(
        fs.statSync(path.join(accountStateDir(root, 'default'), 'credentials.json')).mode & 0o777,
        0o600,
      )
    }

    const second = createAccountStore(root, 'default', { migrateLegacy: true })
    assert.equal(second.loadBuf(), 'cursor-legacy')
    assert.equal(fs.existsSync(path.join(root, 'session-map.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('legacy migration never overwrites an existing account file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-weixin-collision-'))
  try {
    const account = accountStateDir(root, 'default')
    fs.mkdirSync(account, { recursive: true })
    fs.writeFileSync(path.join(account, 'session-map.json'), JSON.stringify({ 'new@im.wechat': 'session-new' }))
    fs.writeFileSync(path.join(root, 'session-map.json'), JSON.stringify({ 'old@im.wechat': 'session-old' }))

    const store = createAccountStore(root, 'default', { migrateLegacy: true })
    assert.deepEqual(store.loadSessionMap(), { 'new@im.wechat': 'session-new' })
    assert.equal(fs.existsSync(path.join(root, 'session-map.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
