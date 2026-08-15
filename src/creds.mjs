/**
 * 插件状态存储：凭证（bot_token/baseurl）、微信用户→会话映射、getupdates 游标。
 * 状态目录由 Config.stateDir 决定；默认落在 $DSH_HOME/dsh-weixin/（无则 ~/.dsh/dsh-weixin/）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 解析状态目录：优先 Config.stateDir，其次 $DSH_HOME，最后 ~/.dsh。 */
export function resolveStateDir(configStateDir) {
  if (configStateDir && String(configStateDir).trim()) return path.resolve(String(configStateDir).trim())
  const home = process.env.DSH_HOME?.trim()
  const base = home || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-weixin')
}

/** 解析 agent 工作目录（会话命名空间 + 文件工具根）。Config.cwd 为空时取 stateDir/workspace，保证跨重启稳定。 */
export function resolveWorkspaceDir(configCwd, stateDir) {
  if (configCwd && String(configCwd).trim()) return path.resolve(String(configCwd).trim())
  return path.join(path.resolve(stateDir), 'workspace')
}

function loadJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return def
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

/** 以 stateDir 为根创建状态存储。 */
export function createStore(stateDir) {
  const dir = path.resolve(stateDir)
  const credFile = path.join(dir, 'credentials.json')
  const sessionMapFile = path.join(dir, 'session-map.json')
  const bufFile = path.join(dir, 'updates-buf.json')

  return {
    dir,
    loadCredentials: () => loadJson(credFile, null),
    saveCredentials: (cred) => saveJson(credFile, cred),
    loadSessionMap: () => loadJson(sessionMapFile, {}),
    saveSessionMap: (map) => saveJson(sessionMapFile, map),
    loadBuf: () => {
      const d = loadJson(bufFile, null)
      return typeof d?.buf === 'string' ? d.buf : ''
    },
    saveBuf: (buf) => saveJson(bufFile, { buf, savedAt: Date.now() }),
  }
}