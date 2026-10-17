import fs from 'node:fs'
import path from 'node:path'
import { createStore, resolveStateDir, resolveWorkspaceDir } from './creds.mjs'

export const DEFAULT_ACCOUNT_ID = 'default'

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_FOLDER_NAME_LENGTH = 128
const RESERVED_ACCOUNT_IDS = new Set([
  'status', 'logs', 'qr.svg', 'login', 'verifycode', 'logout', 'send',
])
const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])

export function assertAccountId(id) {
  const value = String(id ?? '')
  const deviceBase = value.split('.')[0].toUpperCase()
  if (
    !ACCOUNT_ID_RE.test(value)
    || value.endsWith('.')
    || value === '.'
    || value === '..'
    || RESERVED_ACCOUNT_IDS.has(value.toLowerCase())
    || WINDOWS_DEVICE_NAMES.has(deviceBase)
  ) {
    throw new Error('账号 ID 只能包含字母、数字、点、下划线和连字符，且不能以符号开头')
  }
  return value
}

export function accountStateDir(stateDir, accountId) {
  const root = path.resolve(stateDir, 'accounts')
  const dir = path.resolve(root, assertAccountId(accountId))
  if (path.dirname(dir) !== root) throw new Error('账号 ID 不能指向状态目录之外')
  return dir
}

/** 账号文件夹必须是账号根目录下的单段目录名。 */
export function assertFolderName(value) {
  const folder = String(value ?? '').trim()
  const deviceBase = folder.split('.')[0].toUpperCase()
  if (
    !folder
    || folder.length > MAX_FOLDER_NAME_LENGTH
    || folder === '.'
    || folder === '..'
    || folder.includes('/')
    || folder.includes('\\')
    || folder.includes(':')
    || /[\u0000-\u001f\u007f]/.test(folder)
    || WINDOWS_DEVICE_NAMES.has(deviceBase)
    || folder.endsWith('.')
    || folder.endsWith(' ')
  ) {
    throw new Error('文件夹名只能是单段目录名，且不能包含路径分隔符')
  }
  return folder
}

export function resolveAccountWorkspace(accountRoot, folder) {
  const root = String(accountRoot ?? '').trim()
  if (!root) throw new Error('未配置账号目录根 accountRoot')
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, assertFolderName(folder))
  if (path.dirname(resolved) !== resolvedRoot) {
    throw new Error('账号文件夹不能跳出 accountRoot')
  }
  return resolved
}

/** 创建账号目录，并拒绝通过符号链接跳出 accountRoot。 */
export function ensureAccountWorkspace(accountRoot, folder) {
  const dir = resolveAccountWorkspace(accountRoot, folder)
  const root = path.dirname(dir)
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(dir, { recursive: true })
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('账号文件夹不能是符号链接')
  }
  const realRoot = fs.realpathSync(root)
  const realDir = fs.realpathSync(dir)
  if (path.dirname(realDir) !== realRoot) {
    throw new Error('账号文件夹解析后必须仍位于 accountRoot 内')
  }
  return dir
}

export function normalizeAccounts(config = {}) {
  const stateDir = resolveStateDir(config.stateDir)
  const configured = Array.isArray(config.accounts) ? config.accounts : []
  const entries = configured.length
    ? configured
    : [{ id: DEFAULT_ACCOUNT_ID, cwd: config.cwd }]
  const configuredRoot = String(config.accountRoot ?? '').trim()

  const explicitCwds = entries
    .map((entry) => String(entry?.cwd ?? '').trim())
    .filter(Boolean)
  const parents = explicitCwds.map((cwd) => path.dirname(path.resolve(cwd)))
  const inferredRoot = parents.length > 0 && parents.every(
    (parent) => parent.toLowerCase() === parents[0].toLowerCase(),
  ) ? parents[0] : ''
  const accountRoot = configuredRoot ? path.resolve(configuredRoot) : inferredRoot

  const seen = new Set()
  const seenWorkspaces = new Map()
  const accounts = entries.map((entry, index) => {
    const id = assertAccountId(entry?.id)
    const key = id.toLowerCase()
    if (seen.has(key)) throw new Error(`账号 ID 重复：${id}`)
    seen.add(key)

    const state = accountStateDir(stateDir, id)
    const fallbackCwd = !configured.length && index === 0 ? config.cwd : ''
    const configuredCwd = String(entry?.cwd || fallbackCwd || '').trim()
    let folder = String(entry?.folder ?? '').trim()
    let cwd = ''

    if (folder) {
      folder = assertFolderName(folder)
      cwd = resolveAccountWorkspace(accountRoot, folder)
      if (configuredCwd && path.resolve(configuredCwd) !== cwd) {
        throw new Error(`账号 ${id} 的 folder 与 cwd 指向不同目录`)
      }
    } else if (configuredCwd) {
      cwd = path.resolve(configuredCwd)
      if (accountRoot) {
        if (path.dirname(cwd) !== accountRoot) {
          throw new Error(`账号 ${id} 的工作目录必须直接位于 accountRoot 下`)
        }
        folder = path.basename(cwd)
      } else {
        folder = path.basename(cwd)
      }
    } else if (!configured.length) {
      // 单账号旧配置没有 cwd/folder 时维持原有 stateDir/workspace 行为。
      cwd = resolveWorkspaceDir('', state)
      folder = path.basename(cwd)
    }

    if (cwd) {
      const workspaceKey = cwd.toLowerCase()
      const owner = seenWorkspaces.get(workspaceKey)
      if (owner) throw new Error(`账号 ${id} 与 ${owner} 使用了同一个工作目录`)
      seenWorkspaces.set(workspaceKey, id)
    }

    return {
      id,
      stateDir: state,
      folder,
      cwd,
    }
  })

  const requestedDefault = assertAccountId(
    config.defaultAccount || accounts[0].id,
  )
  const defaultAccount = accounts.find(
    (account) => account.id.toLowerCase() === requestedDefault.toLowerCase(),
  )
  if (!defaultAccount) {
    throw new Error(`默认账号不存在：${requestedDefault}`)
  }

  return { stateDir, accountRoot, defaultAccountId: defaultAccount.id, accounts }
}

const LEGACY_FILES = ['credentials.json', 'session-map.json', 'updates-buf.json']

export function createAccountStore(stateDir, accountId, { migrateLegacy = false } = {}) {
  const root = path.resolve(stateDir)
  const dir = accountStateDir(root, accountId)
  if (migrateLegacy) {
    for (const name of LEGACY_FILES) {
      const source = path.join(root, name)
      const destination = path.join(dir, name)
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.renameSync(source, destination)
      if (process.platform !== 'win32') fs.chmodSync(destination, 0o600)
    }
  }
  if (process.platform !== 'win32') {
    if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700)
    for (const name of LEGACY_FILES) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
    }
  }
  return createStore(dir)
}
