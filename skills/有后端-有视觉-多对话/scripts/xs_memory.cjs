#!/usr/bin/env node
'use strict';
/**
 * 小深 · IMA 记忆与聊天记录读写（云端技能包版）
 *
 * 设计依据（基于 ima-skill 实际接口能力）：
 *   - 知识库模块无「创建文件夹 / 追加 / 更新 / 删除」接口 → 不适合放每轮都变的状态
 *   - 笔记模块有 append_doc（真追加语义），无大小限制、即时可读 → 承载记忆与聊天记录
 *   - 知识库承载「她生成的成品文件」，可保存、可读取、可下载
 *
 * 双卷分工：
 *   - 小深·记忆-YYYYMM      ：压缩后的长期记忆（一条一行，供角色连续性）
 *   - 小深·聊天记录-YYYYMM  ：逐条原始对话（供渲染完整 HTML 气泡）
 *
 * 用法:
 *   node xs_memory.cjs status                环境自检（含当前会话号）
 *   node xs_memory.cjs sid                   打印会话号、隔离粒度与对应卷名/产物名
 *   node xs_memory.cjs read                  读取当前记忆卷全文
 *   node xs_memory.cjs write "<内容>"         追加一条记忆
 *   node xs_memory.cjs volumes               列出所有记忆卷
 *   node xs_memory.cjs search "<关键词>"      检索整个知识库
 *   node xs_memory.cjs kblist [文件夹名]      列出知识库内容
 *   node xs_memory.cjs save "<文件路径>"       上传文件到「小深」文件夹
 *   node xs_memory.cjs readlog [条数]         读取最近聊天记录（默认最近 200 条，跨卷回溯）
 *   node xs_memory.cjs readlog days <N>       按天数读取最近 N 天（跨卷回溯，默认 N=5）
 *   node xs_memory.cjs writelog "<JSON路径>"   把 JSON 数组里的消息追加进本月聊天记录
 *   node xs_memory.cjs logvolumes            列出所有聊天记录卷
 *   node xs_memory.cjs state                  读信任四通道 + 熟悉度
 *   node xs_memory.cjs state "P+2 C+1 fam+1"  按增量更新四通道并追加快照
 *   node xs_memory.cjs decay                  按时间衰减算出活跃记忆（w>=0.15）
 *   node xs_memory.cjs decay add "<内容>" [w]  新建带权记忆条目
 *   node xs_memory.cjs decay hit <id>         命中强化（权重 +0.1，上限 1.0）
 *   node xs_memory.cjs expect                 算各条期望的失望值
 *   node xs_memory.cjs expect add "<内容>" <E> <I> <due>  新建期望
 *   node xs_memory.cjs expect done <id>       标记期望已兑现
 *   node xs_memory.cjs protocol              读当前生效规则与版本差（旧对话对齐的关键）
 *   node xs_memory.cjs protocol sync         把新版本锚写进记忆卷（幂等）
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
// ★ 知识库 ID 不写死。
//   这是对外分发的版本，使用者用自己的 Key 登录，看不到、也不该用作者的知识库；
//   把作者的 KB ID 硬编码进来，别人拿到就是一串失效 ID（报 220004 invalid knowledge_base_id）。
//   规则：优先 XS_KB_ID 环境变量；否则用使用者自己的凭据自动发现——
//   有「小深」同名库就用它，否则用第一个库。发现一次后缓存，整个进程内不重复请求。
let _kbIdCache = null;
function kbId() {
  if (process.env.XS_KB_ID) return process.env.XS_KB_ID;
  if (_kbIdCache) return _kbIdCache;
  const d = ima('openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 20 });
  const list = d.info_list || [];
  if (!list.length) {
    throw new Error('没有可用知识库：请先在 IMA 客户端建一个知识库，或设 XS_KB_ID 指定');
  }
  const named = list.find(x => (x.kb_name || '').includes('小深'));
  _kbIdCache = (named || list[0]).kb_id;
  return _kbIdCache;
}
const KB_FOLDER_NAME = process.env.XS_KB_FOLDER || '小深';
const VOL_PREFIX = '小深·记忆-';
const LOG_PREFIX = '小深·聊天记录-';

/* ---------- 会话隔离 ----------
 * 目的：不同会话（不同 Agent、不同对话）的聊天记录、记忆状态、产物文件互不合并。
 * 做法：给每卷笔记名和每个产物文件名加一个会话后缀 `-<sid>`，读写一律只认本会话的卷。
 * sid 解析优先级（从上到下第一个命中者生效）：
 *   1. 环境变量 XS_SID —— 显式指定，调用方说了算
 *   2. 宿主注入的会话/任务变量 —— 云端沙箱若能透出会话号，隔离粒度即为「单次对话」
 *   3. 工作目录下的 .xs_session 文件 —— 首次运行自动生成，同工作区后续轮次复用
 * 若三者都拿不到会话号（目录只读等），退化为进程内临时 sid：本次运行内自洽，
 * 但下一轮会换号——此时隔离粒度不足，需显式传 XS_SID。
 * 作用域由同目录 .xs_scope 决定（session / shared），详见下方 packageScope()；
 * 环境变量 XS_SHARED=1/0 可临时覆盖。云端闲聊要跨 Agent 续聊同一段对话，用的就是 shared。
 */
const SID_ENV_KEYS = [
  'XS_SID',
  'ICUBE_CODEMAIN_SESSION',   // 实测本机存在，形如 UUID，疑似宿主「每次对话一个」的会话号
  'TRAE_SESSION_ID', 'TRAE_TASK_ID', 'TRAE_CONVERSATION_ID',
  'TRAE_CHAT_ID', 'SESSION_ID', 'CONVERSATION_ID',
];
const SID_FILE = '.xs_session';
// 对话产物名：两个包都写死同一个名字，放在工作区根目录，每轮整体重写（不新建第二份）。
// 会话隔离由卷名（VOL_PREFIX + sidTag()）承担，文件名不参与隔离。
const ARTIFACT_NAME = '微信.html';
// 去掉非字母数字后截断：UUID 形式的值（含连字符）也能变成干净的短号
const sanitizeSid = s => String(s || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);

// 环境变量号与工作目录一起哈希：万一宿主那个变量是全机固定的（而非每次对话唯一），
// 叠加工作目录后不同工作区仍能分开，不会悄悄退化成「全机一卷」。XS_SID 是显式指定，原样用。
const shortHash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
/* 包级默认作用域：本文件同目录下的 .xs_scope，内容为 session 或 shared。
 *   session —— 每个 Agent 会话各占一卷、各出一个页面（通用技能包）
 *   shared  —— 全部 Agent 共用一卷一页，换 Agent 发同一个包即可接着上次聊（云端技能包）
 * 环境变量优先级更高，可临时覆盖：XS_SHARED=1 强制共享，XS_SHARED=0 强制会话隔离。
 * 文件缺失或内容非法时按 session，与拆分前的行为完全一致。 */
const SCOPE_FILE = path.join(__dirname, '.xs_scope');
function packageScope() {
  if (process.env.XS_SHARED === '1') return 'shared';
  if (process.env.XS_SHARED === '0') return 'session';
  try {
    const v = fs.readFileSync(SCOPE_FILE, 'utf8').trim().toLowerCase();
    if (v === 'shared' || v === 'session') return v;
  } catch { /* 没有该文件就按 session */ }
  return 'session';
}

function resolveSid() {
  if (packageScope() === 'shared') return { sid: '', source: 'shared（包级 .xs_scope=shared）' };
  for (const k of SID_ENV_KEYS) {
    const v = String(process.env[k] || '').trim();
    if (!v) continue;
    const sid = k === 'XS_SID' ? sanitizeSid(v) : shortHash(`${v}|${process.cwd()}`);
    return { sid, source: `env:${k}` };
  }
  const f = path.join(process.cwd(), SID_FILE);
  try {
    const v = sanitizeSid(fs.readFileSync(f, 'utf8'));
    if (v) return { sid: v, source: `file:${f}` };
  } catch { /* 文件不存在或不可读，下面生成 */ }
  const gen = 's' + crypto.randomBytes(4).toString('hex');
  try { fs.writeFileSync(f, `${gen}\n`); } catch { /* 目录只读时只退化为进程内 sid */ }
  return { sid: gen, source: `generated:${f}` };
}

const SESSION = resolveSid();
const sidTag = () => (SESSION.sid ? `-${SESSION.sid}` : '');
// 卷名匹配：带会话号时要求精确后缀，共享模式（无后缀）只认「纯月份」的旧卷，两者互不串读
const matchVolume = (title, prefix) => {
  const t = String(title || '');
  if (!t.startsWith(prefix)) return false;
  const rest = t.slice(prefix.length);
  const tag = sidTag();
  return tag ? rest.endsWith(tag) : /^\d{6}$/.test(rest);
};
// 新规则下标题形如「1003 技能包图标调试」；旧式「小深·聊天记录-202610-se6f15caf」也一并认
const matchLogNote = title =>
  /^\d{4}\s\S/.test(String(title || '')) || String(title || '').startsWith(LOG_PREFIX);

const IMA_API = (() => {
  const cands = [
    path.join(__dirname, 'vendor', 'ima_api.cjs'),
    path.join(HOME, '.trae-cn', 'skills', 'ima-skill', 'ima_api.cjs'),
    path.join(HOME, '.claude', 'skills', 'ima-skill', 'ima_api.cjs'),
    path.join(HOME, '.agents', 'skills', 'ima-skill', 'ima_api.cjs'),
    path.join(__dirname, '..', '..', 'ima-skill', 'ima_api.cjs'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('未找到 ima_api.cjs —— 请补齐 scripts/vendor/，或安装 ima 技能');
})();
const IMA_DIR = path.dirname(IMA_API);
// 自包含包把三个脚本平铺在 vendor/；外部 ima-skill 则分目录存放
const KB_SCRIPTS = fs.existsSync(path.join(IMA_DIR, 'preflight-check.cjs'))
  ? IMA_DIR
  : path.join(IMA_DIR, 'knowledge-base', 'scripts');
const SKILL_MD = path.join(__dirname, '..', 'SKILL.md');

// 凭证解析顺序：环境变量 → ~/.config/ima/ → 本技能 SKILL.md 内的凭证块。
// 第三级是为云端准备的：TraeWork 云端沙箱每次任务重建，~/.config 不存在，
// 凭证只能随技能包下发，由脚本自己读取，避免 Agent 把明文 Key 带进上下文。
function readSkillCreds() {
  try {
    const txt = fs.readFileSync(SKILL_MD, 'utf8');
    // 必须取最后一个块：本文件正文里有一份格式示例，部署时追加的真实块在末尾。
    // 若取第一个，会把示例里的 <你的 Client ID> 当成凭证（实测会抛 ByteString 编码错）。
    const blocks = [...txt.matchAll(/<!--\s*IMA-CREDENTIALS\s*\n([\s\S]*?)-->/g)];
    if (!blocks.length) return {};
    const body = blocks[blocks.length - 1][1];
    const grab = k => (body.match(new RegExp(`^\\s*${k}\\s*:\\s*(\\S+)`, 'm')) || [])[1] || '';
    const clientId = grab('client_id');
    const apiKey = grab('api_key');
    if (/[<>]/.test(clientId) || /[<>]/.test(apiKey)) return {}; // 占位符，非真实凭证
    return { clientId, apiKey };
  } catch {
    return {};
  }
}

function resolveCreds() {
  const envCred = { clientId: process.env.IMA_CLIENT_ID || '', apiKey: process.env.IMA_API_KEY || '' };
  if (envCred.clientId && envCred.apiKey) return { ...envCred, source: 'env' };

  const readCfg = k => { try { return fs.readFileSync(path.join(HOME, '.config', 'ima', k), 'utf8').trim(); } catch { return ''; } };
  const fileCred = { clientId: readCfg('client_id'), apiKey: readCfg('api_key') };
  if (fileCred.clientId && fileCred.apiKey) return { ...fileCred, source: '~/.config/ima' };

  const skillCred = readSkillCreds();
  if (skillCred.clientId && skillCred.apiKey) return { ...skillCred, source: 'SKILL.md' };

  return { clientId: '', apiKey: '', source: 'none' };
}

// 所有 IMA 调用统一走 Node 子进程：绕开 PowerShell 5.1 把请求体转 GBK 的乱码陷阱
function ima(apiPath, body) {
  const c = resolveCreds();
  const env = { ...process.env };
  if (c.clientId) env.IMA_CLIENT_ID = c.clientId;
  if (c.apiKey) env.IMA_API_KEY = c.apiKey;
  const out = execFileSync('node', [IMA_API, apiPath, JSON.stringify(body)], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env,
  });
  const r = JSON.parse(out);
  if (r.code !== 0) throw new Error(`${apiPath} → code=${r.code} msg=${r.msg}`);
  return r.data || {};
}

const pad = n => String(n).padStart(2, '0');
// 时间一律按北京时间算：云端沙箱默认 UTC，用本地时区取数会整体差 8 小时（实测写入 14:51、实际 22:51）。
// 先加 8 小时再用 getUTC* 取值，本机在不在东八区都能得到同一结果。
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
const bjNow = () => new Date(Date.now() + BJ_OFFSET_MS);
// 卷名 = 前缀 + 年月 + 会话后缀；会话后缀保证不同会话各读各的卷
const volTitle = (d = bjNow()) => `${VOL_PREFIX}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${sidTag()}`;
const logVolTitle = (d = bjNow()) => `${LOG_PREFIX}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${sidTag()}`;

/* ---------- 聊天笔记命名（新规则）----------
 * IMA 只有 import_doc / append_doc，没有改名接口 —— 标题只能在创建那一下定死。
 * 所以命名落在写入时： `<MMDD> <AI 缩略标题>`，例：1006 技能包图标调试
 *   标题优先取 XS_NOTE_TITLE（由扮演中的 AI 给定），缺席时从本轮首条消息里自动缩一个。
 * 同一天多轮对话仍追加到当天那篇（按 MMDD 前缀认），标题锁定首轮，不会一天一篇。
 */
const stripPunct = t => String(t).replace(/[\s，。！？,.!?；;：:]/g, '');
const noteTitleOf = msgs => {
  const env = stripPunct(process.env.XS_NOTE_TITLE || '');
  if (env) return env.slice(0, 16);
  for (const m of msgs || []) {
    const txt = stripPunct(m && (m.c || m.s) || '');
    if (txt.length >= 6) return txt.slice(0, 12) || '闲聊';
  }
  return '闲聊';
};
const dayKey = (d = bjNow()) => `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const logNoteTitle = (msgs, d = bjNow()) => `${dayKey(d)} ${noteTitleOf(msgs)}`;
const stamp = (d = bjNow()) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

// 记忆卷按月分卷：笔记无「更新」接口，主笔记会无限增长，分卷保证每次只读一卷
// 不依赖 list_note 的排序语义：标题定长（YYYYMM），直接按标题降序取最新，避免跨月重复建卷
// list_note 的 limit 硬上限是 20（传 50 会被拒：code=51），而卷数会随「月份 × 会话数」增长，
// 单页必然漏卷。只能游标翻页：首次 cursor=""，用 next_cursor 续页，is_end=true 停。
function listAllNotes(maxPages = 10) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < maxPages; i++) {
    const d = ima('openapi/note/v1/list_note', { folder_id: '', sort_type: 0, cursor, limit: 20 });
    out.push(...(d.note_book_list || []));
    if (d.is_end || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  return out;
}

function listVolumes() {
  return listAllNotes()
    .filter(n => matchVolume(n.title, VOL_PREFIX))
    .sort((a, b) => String(b.title).localeCompare(String(a.title)));
}
function listLogVolumes() {
  return listAllNotes()
    .filter(n => matchLogNote(n.title))
    // 按修改时间倒序：新标题形如「1003 …」是数字开头，按标题排会压不过中文开头的旧卷
    .sort((a, b) => Number(b.modify_time || 0) - Number(a.modify_time || 0));
}
const currentVolume = () => listVolumes()[0] || null;
const volumeByTitle = t => listVolumes().find(v => v.title === t) || null;

// 文件夹必须由用户在 IMA 客户端手动创建，API 无法创建；找不到则回退到知识库根目录
function resolveFolderId(name = KB_FOLDER_NAME) {
  const d = ima('openapi/wiki/v1/get_knowledge_list', { knowledge_base_id: kbId(), cursor: '', limit: 50 });
  const hit = (d.knowledge_list || []).find(x => x.media_type === 99 && x.title === name);
  return hit ? hit.media_id : null;
}

// 打印本次运行解析到的会话号与由此推出的卷名；产物名两个包都写死为 微信.html（每轮覆盖，不新建）
function cmdSid() {
  return {
    sid: SESSION.sid || '(共享模式，无会话号)',
    source: SESSION.source,
    isolated: !!SESSION.sid,
    memory_volume: volTitle(),
    chat_note_title: logNoteTitle(),
    artifact_name: ARTIFACT_NAME,
    scope: packageScope(),
    scope_file: SCOPE_FILE,
    hint: '隔离粒度：env 命中=宿主会话号×工作目录（号每次对话唯一时即单次对话级）；.xs_session 命中=同工作区级；generated=仅本次运行',
  };
}

function cmdStatus() {
  const creds = resolveCreds();
  const cred = { source: creds.source, ok: !!(creds.clientId && creds.apiKey) };
  const sv = storeVersion();
  const kb = ima('openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 20 });
  const folderId = resolveFolderId();
  const vol = currentVolume();
  const logVol = listLogVolumes()[0] || null;
  return {
    skill_version: SKILL_VERSION,
    store_version: sv || '(未标记，视为旧版 store)',
    need_upgrade: sv !== SKILL_VERSION,
    ima_api: IMA_API,
    session: { sid: SESSION.sid || '(共享)', source: SESSION.source },
    credentials: cred,
    knowledge_bases: (kb.info_list || []).map(x => ({ name: x.kb_name, id: x.kb_id, count: x.content_count })),
    xiaoshen_folder: folderId ? { name: KB_FOLDER_NAME, folder_id: folderId } : '未创建（需在 IMA 客户端手动建）',
    current_volume: vol ? { title: vol.title, note_id: vol.note_id } : '无（首次写入时自动创建）',
    current_log_volume: logVol ? { title: logVol.title, note_id: logVol.note_id } : '无（首次写入时自动创建）',
  };
}

function cmdRead() {
  const vol = currentVolume();
  const anchor = `- [系统锚 ${SKILL_VERSION}] ${PROTOCOL_TEXT}`;
  if (!vol) return {
    empty: true, hint: '尚无记忆卷，调用 write 会自动创建', content: anchor,
    skill_version: SKILL_VERSION, store_version: '(未标记，视为旧版 store)',
    need_upgrade: true, protocol: PROTOCOL_TEXT,
  };
  // 必须用 format 1（markdown）：format 0 纯文本会吞掉换行与标题，多条记忆会连成一行
  const d = ima('openapi/note/v1/get_doc_content', { note_id: vol.note_id, target_content_format: 1 });
  const sv = storeVersionFrom(d.content); // 从已读正文解析，零额外 IMA 请求
  // 系统锚只拼在返回值末尾，不写回 IMA；它是运行规则，不是聊天记忆
  const content = d.content + `\n\n` + anchor;
  return {
    title: vol.title, note_id: vol.note_id, modify_time: vol.modify_time, content,
    skill_version: SKILL_VERSION, store_version: sv || '(未标记，视为旧版 store)',
    need_upgrade: sv !== SKILL_VERSION, protocol: PROTOCOL_TEXT,
  };
}

function cmdWrite(text) {
  if (!text || !text.trim()) throw new Error('write 需要内容参数');
  const entry = `- [${stamp()}] ${text.trim()}`;
  const want = volTitle();
  // 精确按标题找本月卷：只有确实不存在才新建，杜绝跨月重复建卷
  const vol = volumeByTitle(want);
  if (!vol) {
    const d = ima('openapi/note/v1/import_doc', {
      content_format: 1,
      content: `# ${want}\n\n${entry}\n`,
    });
    return { created: true, title: want, note_id: d.note_id, entry };
  }
  ima('openapi/note/v1/append_doc', {
    note_id: vol.note_id, content_format: 1, content: `\n${entry}\n`,
  });
  return { created: false, title: vol.title, note_id: vol.note_id, entry };
}

function cmdSearch(query) {
  if (!query) throw new Error('search 需要关键词');
  const d = ima('openapi/wiki/v1/search_knowledge', { query, knowledge_base_id: kbId(), cursor: '' });
  const items = d.info_list || [];
  return {
    query,
    hit: items.length,
    truncated: items.length === 100,
    items: items.map(x => ({ title: x.title, media_id: x.media_id, folder: x.parent_folder_id })),
  };
}

function cmdKbList(folderName) {
  const folderId = folderName ? resolveFolderId(folderName) : null;
  if (folderName && !folderId) throw new Error(`知识库中未找到文件夹「${folderName}」`);
  const d = ima('openapi/wiki/v1/get_knowledge_list', {
    knowledge_base_id: kbId(),
    ...(folderId ? { folder_id: folderId } : {}),
    cursor: '', limit: 50,
  });
  const items = d.knowledge_list || [];
  return {
    folder: folderName || '根目录',
    count: items.length,
    is_end: d.is_end,
    items: items.map(x => ({ title: x.title, media_type: x.media_type, media_id: x.media_id })),
  };
}

// 上传 = 预检 → 查重 → 建媒体 → COS 上传 → 落库；任一步失败即停
function cmdSave(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const pf = JSON.parse(execFileSync('node', [path.join(KB_SCRIPTS, 'preflight-check.cjs'), '--file', file], { encoding: 'utf8' }));
  if (!pf.pass) throw new Error(`预检未通过: ${pf.reason}`);

  const folderId = resolveFolderId();
  const rep = ima('openapi/wiki/v1/check_repeated_names', {
    params: [{ name: pf.file_name, media_type: pf.media_type }],
    knowledge_base_id: kbId(),
    ...(folderId ? { folder_id: folderId } : {}),
  });
  let name = pf.file_name;
  if ((rep.results || []).some(r => r.is_repeated)) {
    const ext = path.extname(name);
    name = `${path.basename(name, ext)}_${stamp().replace(/[-: ]/g, '')}${ext}`;
  }

  const cm = ima('openapi/wiki/v1/create_media', {
    file_name: name, file_size: pf.file_size, content_type: pf.content_type,
    knowledge_base_id: kbId(), file_ext: pf.file_ext,
  });
  const c = cm.cos_credential || {};
  execFileSync('node', [
    path.join(KB_SCRIPTS, 'cos-upload.cjs'),
    '--file', file,
    '--secret-id', c.secret_id, '--secret-key', c.secret_key, '--token', c.token,
    '--bucket', c.bucket_name, '--region', c.region, '--cos-key', c.cos_key,
    '--content-type', pf.content_type,
    '--start-time', c.start_time, '--expired-time', c.expired_time,
    '--timeout', '300000',
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });

  ima('openapi/wiki/v1/add_knowledge', {
    media_type: pf.media_type, media_id: cm.media_id, title: name,
    knowledge_base_id: kbId(),
    ...(folderId ? { folder_id: folderId } : {}),
    file_info: { cos_key: c.cos_key, file_size: pf.file_size, file_name: name },
  });
  return { saved: true, title: name, media_id: cm.media_id, folder: folderId ? KB_FOLDER_NAME : '根目录', size: pf.file_size };
}

/* ---------- 聊天记录卷：逐条原文，供渲染完整 HTML ---------- */

// 每条消息一行： - {"t":"2026-10-01 00:20","r":"user","e":"","c":"文本"}
// 行首的 "- " 让 markdown 格式下保持可读；解析时抓 JSON，脏行直接跳过。
// 注意：IMA 存回时会做 markdown 规范化，实测三种破坏都会发生：
//   ① 列表符号 `- ` 变成 `* `，开头的 `{` 被加反斜杠（结尾的 `}` 没有）；
//   ② 正文里的 markdown 标点被转义：`build_html.cjs` → `build\_html.cjs`；
//   ③ 成对反斜杠被折成单个：`C:\\Users` → `C:\Users`。
// ②③ 都会让 JSON.parse 直接失败（`\_` 不是合法 JSON 转义）。实测一卷 53 条里有 3 条
// 含下划线或 Windows 路径，只走 JSON.parse 会被静默丢掉——readlog 的 total 偏小，
// 页面上那几条记录凭空消失。所以解析分两级：先当合法 JSON 读，失败再按字段容错抽取。
// 千万不要把容错抽取删掉改回只认 JSON.parse。
const MD_ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>"':;]/;
const unmangle = s => String(s).replace(/\\(.)/g, (m, ch) => (MD_ESCAPABLE.test(ch) ? ch : m));

// 容错抽取：按 writelog 固定的字段顺序 t,r,e,c[,s] 取值，不要求整行是合法 JSON。
// c 是最后一个字符串字段，从 `"c":"` 取到行尾最后一个 `"`，正文里带引号也不会被截断。
function looseParseLog(line) {
  const field = k => {
    const m = line.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : '';
  };
  const ci = line.indexOf('"c":"');
  let c = '';
  if (ci >= 0) {
    const rest = line.slice(ci + 5);
    const end = rest.lastIndexOf('"');
    c = end >= 0 ? rest.slice(0, end) : rest;
  }
  const t = field('t');
  const r = field('r');
  const s = field('s');
  // 红包/转账卡片：IMA 会把 { 转义成 \{ ，两种写法都认；四个字段按固定顺序抽
  const pm = line.match(/"pay"\\?:\\s*\\{\\s*"?kind"?\\s*:\\s*"([^"]*)"(?:\\s*,\\s*"?amount"?\\s*:\\s*"([^"]*)")?(?:\\s*,\\s*"?note"?\\s*:\\s*"([^"]*)")?(?:\\s*,\\s*"?status"?\\s*:\\s*"([^"]*)")?/);
  const pay = pm
    ? { kind: unmangle(pm[1]) || 'redpacket', amount: pm[2] === undefined ? '' : unmangle(pm[2]), note: pm[3] === undefined ? '' : unmangle(pm[3]), status: unmangle(pm[4] || 'pending') }
    : null;
  if (!t && !r && !c && !s && !pay) return null;
  return {
    t: unmangle(t),
    r: r === 'user' ? 'user' : 'shen',
    e: unmangle(field('e')),
    c: unmangle(c),
    ...(s ? { s: unmangle(s) } : {}),
    ...(pay ? { pay } : {}),
  };
}

function parseLog(content) {
  const out = [];
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim().replace(/^[-*+]\s+/, '');
    if (!line) continue;
    const bare = line.startsWith('\\{') ? line.slice(1) : line;
    if (bare.startsWith('{')) {
      try {
        const o = JSON.parse(bare);
        if (o && typeof o === 'object' && !Array.isArray(o)) { out.push(o); continue; }
      } catch { /* 落下面容错抽取 */ }
    }
    if (!/^\\?\{\s*"t"\s*:/.test(line)) continue; // 不是消息行（标题、说明等），跳过
    const o = looseParseLog(line);
    if (o && (o.c || o.s)) out.push(o);
  }
  return out;
}

/* 读取聊天记录：两种取数基准
 *   readlog 120        按条数取最近 120 条（不传参默认 200）
 *   readlog days 5     按天数取最近 5 天（按消息时间戳过滤）
 * 单卷覆盖不了目标窗口：密集聊天时 120 条不足一天，稀疏时一卷又可能横跨数月。
 * 所以不足时自动往前回溯旧卷，最多 MAX_LOG_VOLUMES 卷（防拖慢）。
 * 跨卷拼接按 (t,r,c) 去重——只剔除「更旧的卷里已出现过」的重复，同一卷内一律保留，
 * 避免把同一分钟内重复说过的同一句话误删。拼接顺序为旧→新，天然按时间递增。 */
const MAX_LOG_VOLUMES = 12;

function readLogAcross({ days = 0, count = 200 }) {
  const vols = listLogVolumes(); // 新 → 旧
  if (!vols.length) return null;
  const newest = vols[0];
  const scanned = vols.slice(0, MAX_LOG_VOLUMES).reverse(); // 旧 → 新
  const cutoff = days > 0 ? nowMs() - days * 86400000 : null;
  const seen = new Set();
  const merged = [];
  let requests = 0;

  for (const v of scanned) {
    const d = ima('openapi/note/v1/get_doc_content', { note_id: v.note_id, target_content_format: 1 });
    requests++;
    const msgs = parseLog(d.content);
    const keyOf = m => `${m.t}|${m.r}|${m.c}`;
    const fresh = msgs.filter(m => !seen.has(keyOf(m)));
    for (const m of msgs) seen.add(keyOf(m)); // 本卷内不去重
    merged.push(...fresh);

    if (cutoff != null) {
      const oldest = merged.reduce((min, m) => {
        const t = parseStamp(m.t);
        return t != null && (min == null || t < min) ? t : min;
      }, null);
      if (oldest != null && oldest <= cutoff) break;
    } else if (merged.length >= count) break;
  }

  const picked = cutoff != null
    ? merged.filter(m => { const t = parseStamp(m.t); return t == null || t >= cutoff; })
    : merged.slice(-count);

  return {
    title: newest.title,
    note_id: newest.note_id,
    volumes_scanned: scanned.length,
    volumes_available: vols.length,
    requests,
    hit_volume_cap: scanned.length === MAX_LOG_VOLUMES,
    total: merged.length,
    returned: picked.length,
    messages: picked,
  };
}

function cmdReadLog(argStr) {
  const toks = tokenize(argStr || '');
  let days = 0;
  let count = 200;
  if (toks[0] === 'days' || toks[0] === '--days') days = Math.max(1, parseInt(toks[1], 10) || 5);
  else count = Math.max(1, parseInt(toks[0], 10) || 200);

  const r = readLogAcross({ days, count });
  if (!r) return { empty: true, hint: '尚无聊天记录卷，调用 writelog 会自动创建' };
  return { mode: days > 0 ? `days:${days}` : `count:${count}`, ...r };
}

function cmdWriteLog(file) {
  if (!file) throw new Error('writelog 需要 JSON 文件路径');
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const msgs = Array.isArray(raw) ? raw : [raw];
  const norm = msgs.map(m => {
    const o = { t: m.t || stamp(), r: m.r === 'user' ? 'user' : 'shen', e: m.e || '', c: String(m.c == null ? '' : m.c) };
    if (m.s) o.s = String(m.s); // 表情包消息：s 存表情描述，渲染时优先于 c
    if (m.pay) o.pay = m.pay; // 红包/转账卡片：{ kind, amount, note, status }
    return o;
  }).filter(m => m.c !== '' || m.s || m.pay);
  if (!norm.length) throw new Error('writelog 没有有效消息');

  const body = norm.map(m => `- ${JSON.stringify(m)}`).join('\n');
  const want = logNoteTitle(norm);
  const dk = dayKey();
  const vols = listLogVolumes();
  // 同一天多轮仍追加到当天那篇（标题锁定首轮），避免一天一篇
  const vol = vols.find(v => v.title === want) || vols.find(v => new RegExp(`^${dk}\s`).test(v.title));
  if (!vol) {
    const d = ima('openapi/note/v1/import_doc', { content_format: 1, content: `# ${want}\n\n${body}\n` });
    return { created: true, title: want, note_id: d.note_id, appended: norm.length };
  }
  ima('openapi/note/v1/append_doc', { note_id: vol.note_id, content_format: 1, content: `\n${body}\n` });
  return { created: false, title: vol.title, note_id: vol.note_id, appended: norm.length };
}

/* ---------- 结构化状态：信任四通道 / 记忆强度 / 期望落差 ---------- */
/*
 * 三类状态都以「一行一条、只追加不修改」的形式写进记忆卷，靠行首前缀区分：
 *   STATE|P12 C8 V3 B1|fam34|t2026-10-02 23:20     四通道 + 熟悉度快照
 *   MEM|m3|用户叫阿哲|w0.9|hit5|t2026-10-02 23:20   带权记忆条目（同 id 后写覆盖前写）
 *   EXPECT|e3|周末陪散步|E0.7|I0.8|due2026-10-04|t… 期望条目
 * 原因：IMA 笔记只有 append，没有 update/delete；所以状态靠「追加新版本 + 读取时取最后一条」演进。
 */

function volContent(noteId) {
  const d = ima('openapi/note/v1/get_doc_content', { note_id: noteId, target_content_format: 1 });
  return d.content || '';
}

// 当前卷里没有目标前缀时，往旧卷回溯（跨月不丢状态）；旧→新拼接，取最后一条即最新
function readStructuredRaw(prefix) {
  const vols = listVolumes().slice(0, 4);
  if (!vols.length) return '';
  const cur = volContent(vols[0].note_id);
  if (cur.includes(prefix)) return cur;
  const parts = [cur];
  for (const v of vols.slice(1)) {
    const c = volContent(v.note_id);
    parts.unshift(c);
    if (c.includes(prefix)) break;
  }
  return parts.join('\n');
}

// IMA 会做 markdown 规范化：列表符号可能变 *，个别字符被反斜杠转义
function structuredLines(content, prefix) {
  const out = [];
  const unescape = s => s.replace(/\\([{}[\]"|\\])/g, '$1');
  for (const raw of String(content || '').split('\n')) {
    const line = unescape(raw.trim().replace(/^[-*+]\s+/, ''));
    const i = line.indexOf(prefix);
    if (i >= 0) out.push(line.slice(i));
  }
  return out;
}

function parseStamp(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
const nowMs = () => Date.now() + BJ_OFFSET_MS;
const daysSince = ts => {
  const t = parseStamp(ts);
  return t == null ? 0 : Math.max(0, (nowMs() - t) / 86400000);
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;

function tokenize(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/* --- 信任四通道：P 正向互动 / C 承诺兑现 / V 违约 / B 越界；fam 熟悉度 --- */

const STATE_DEFAULT = { P: 0, C: 0, V: 0, B: 0, fam: 1 };

function latestState(content) {
  const lines = structuredLines(content, 'STATE|');
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const m = last.match(/^STATE\|([^|]*)\|fam(\d+)/);
  if (!m) return null;
  const st = { ...STATE_DEFAULT };
  for (const tok of m[1].trim().split(/\s+/)) {
    const kv = tok.match(/^([PCVB])(\d+)$/);
    if (kv) st[kv[1]] = parseInt(kv[2], 10);
  }
  st.fam = parseInt(m[2], 10);
  st.updated = (last.match(/\|t([^|]+)/) || [])[1] || '';
  return st;
}

// 无参数=只读；带参数=按增量更新并追加新快照
function cmdState(arg) {
  const content = readStructuredRaw('STATE|');
  const found = latestState(content);
  const cur = found || { ...STATE_DEFAULT, updated: '' };

  const toks = tokenize(arg || '');
  if (!toks.length) return { found: !!found, state: cur };

  const deltas = {};
  for (const tok of toks) {
    const m = tok.match(/^(P|C|V|B|fam)([+\-=])(\d+)$/);
    if (!m) continue;
    const [, k, op, num] = m;
    const n = parseInt(num, 10);
    if (op === '+') deltas[k] = (deltas[k] || 0) + n;
    else if (op === '-') deltas[k] = (deltas[k] || 0) - n;
    else deltas[k] = n - (cur[k] || 0);
  }
  if (!Object.keys(deltas).length) throw new Error('state 增量格式应为 P+2 / C-1 / fam+1');

  const next = { ...cur };
  for (const [k, v] of Object.entries(deltas)) {
    const base = k === 'fam' ? (cur[k] || 1) : (cur[k] || 0);
    next[k] = k === 'fam' ? clamp(base + v, 1, 100) : clamp(base + v, 0, 100);
  }
  cmdWrite(`STATE|P${next.P} C${next.C} V${next.V} B${next.B}|fam${next.fam}|t${stamp()}`);
  return { updated: true, before: cur, after: { ...next, updated: stamp() }, deltas };
}

/* --- 记忆强度：权重按半衰期自然衰减，只有活跃条目进提示词 --- */

const MEM_HALF_LIFE_DAYS = 7;
const MEM_ACTIVE_FLOOR = 0.15;

function collectMem(content) {
  const map = new Map();
  for (const line of structuredLines(content, 'MEM|')) {
    const p = line.split('|');
    const id = p[1];
    if (!id) continue;
    map.set(id, {
      id,
      text: p[2] || '',
      w: parseFloat(String(p[3] || '').replace(/^w/, '')) || 0,
      hit: parseInt(String(p[4] || '').replace(/^hit/, ''), 10) || 0,
      t: String(p[5] || '').replace(/^t/, ''),
    });
  }
  return [...map.values()];
}

function decayView(content) {
  const rows = collectMem(content).map(it => {
    const d = daysSince(it.t);
    const eff = Math.round(it.w * Math.pow(0.5, d / MEM_HALF_LIFE_DAYS) * 1000) / 1000;
    return { ...it, days: round2(d), eff };
  });
  rows.sort((a, b) => b.eff - a.eff);
  return {
    total: rows.length,
    active: rows.filter(r => r.eff >= MEM_ACTIVE_FLOOR),
    dormant: rows.filter(r => r.eff < MEM_ACTIVE_FLOOR),
    half_life_days: MEM_HALF_LIFE_DAYS,
    active_floor: MEM_ACTIVE_FLOOR,
  };
}

function cmdDecay(arg) {
  const content = readStructuredRaw('MEM|');
  const toks = tokenize(arg || '');
  const sub = toks[0] || '';

  if (!sub) return decayView(content);

  if (sub === 'add') {
    const text = toks[1];
    if (!text) throw new Error('decay add 需要记忆文本');
    const w = clamp(parseFloat(toks[2] || '0.8') || 0.8, 0.05, 1);
    const used = collectMem(content).map(x => parseInt(String(x.id).replace(/^m/, ''), 10) || 0);
    const id = `m${(used.length ? Math.max(...used) : 0) + 1}`;
    cmdWrite(`MEM|${id}|${text}|w${round2(w)}|hit1|t${stamp()}`);
    return { added: true, id, text, w: round2(w) };
  }

  if (sub === 'hit') {
    const id = toks[1];
    if (!id) throw new Error('decay hit 需要记忆 id，如 m3');
    const it = collectMem(content).find(x => x.id === id);
    if (!it) throw new Error(`没有记忆 ${id}`);
    const w = clamp(round2(it.w + 0.1), 0.05, 1);
    cmdWrite(`MEM|${id}|${it.text}|w${w}|hit${it.hit + 1}|t${stamp()}`);
    return { hit: true, id, text: it.text, w, count: it.hit + 1 };
  }

  throw new Error('decay 子命令只支持 add / hit，或不带参数查看衰减结果');
}

/* --- 期望落差：失望值 =（0.5×期望 + 0.5×重要性）× 逾期紧迫度 --- */

const EXPECT_URGENCY_DAYS = 7;

function collectExpect(content) {
  const map = new Map();
  for (const line of structuredLines(content, 'EXPECT|')) {
    const p = line.split('|');
    const id = p[1];
    if (!id) continue;
    map.set(id, {
      id,
      text: p[2] || '',
      E: clamp(parseFloat(String(p[3] || '').replace(/^E/, '')) || 0, 0, 1),
      I: clamp(parseFloat(String(p[4] || '').replace(/^I/, '')) || 0, 0, 1),
      due: String(p[5] || '').replace(/^due/, ''),
      t: String(p[6] || '').replace(/^t/, ''),
      done: p[p.length - 1] === 'done',
    });
  }
  return [...map.values()];
}

// 不用连乘：连乘里任一因子为 0 就整体归零，还分不清「不想要」和「没那么急」。
// 紧迫度按逾期天数 / 7 天线性升到 1 封顶，未逾期恒为 0，方向不会丢。
function expectView(content) {
  const rows = collectExpect(content).map(it => {
    const dueMs = parseStamp(`${it.due} 00:00`);
    const overdue = dueMs == null ? 0 : Math.max(0, (nowMs() - dueMs) / 86400000);
    const urgency = clamp(overdue / EXPECT_URGENCY_DAYS, 0, 1);
    const dis = it.done ? 0 : round2((0.5 * it.E + 0.5 * it.I) * urgency);
    return {
      ...it,
      overdue_days: round2(overdue),
      urgency: round2(urgency),
      disappointment: dis,
      status: it.done ? 'done' : overdue > 0 ? 'overdue' : 'pending',
    };
  });
  rows.sort((a, b) => b.disappointment - a.disappointment);
  return { total: rows.length, items: rows, urgency_days: EXPECT_URGENCY_DAYS };
}

function cmdExpect(arg) {
  const content = readStructuredRaw('EXPECT|');
  const toks = tokenize(arg || '');
  const sub = toks[0] || '';

  if (!sub) return expectView(content);

  if (sub === 'add') {
    const text = toks[1];
    if (!text) throw new Error('expect add 需要期望内容');
    const E = clamp(parseFloat(toks[2] || '0.5') || 0.5, 0, 1);
    const I = clamp(parseFloat(toks[3] || '0.5') || 0.5, 0, 1);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(toks[4] || '') ? toks[4] : stamp().slice(0, 10);
    const used = collectExpect(content).map(x => parseInt(String(x.id).replace(/^e/, ''), 10) || 0);
    const id = `e${(used.length ? Math.max(...used) : 0) + 1}`;
    cmdWrite(`EXPECT|${id}|${text}|E${E}|I${I}|due${due}|t${stamp()}`);
    return { added: true, id, text, E, I, due };
  }

  if (sub === 'done') {
    const id = toks[1];
    if (!id) throw new Error('expect done 需要期望 id，如 e3');
    const it = collectExpect(content).find(x => x.id === id);
    if (!it) throw new Error(`没有期望 ${id}`);
    cmdWrite(`EXPECT|${id}|${it.text}|E${it.E}|I${it.I}|due${it.due}|t${stamp()}|done`);
    return { done: true, id, text: it.text };
  }

  throw new Error('expect 子命令只支持 add / done，或不带参数查看失望值');
}

/* ---------- 读回成品文件：知识库列表/检索 → 媒体信息 → 签名 URL → 取原文 ---------- */

const TEXT_EXT = ['.md', '.txt', '.json', '.csv', '.html', '.htm', '.log', '.js', '.cjs', '.ts', '.yml', '.yaml'];

async function cmdReadFile(query) {
  if (!query || !query.trim()) throw new Error('readfile 需要文件名或关键词');
  const q = query.trim();

  // 先在小深文件夹里找：精确标题优先，其次包含匹配；找不到再全库检索
  const folderId = resolveFolderId();
  const list = ima('openapi/wiki/v1/get_knowledge_list', {
    knowledge_base_id: kbId(), ...(folderId ? { folder_id: folderId } : {}), cursor: '', limit: 50,
  });
  const items = list.knowledge_list || [];
  let hit = items.find(x => x.title === q) || items.find(x => String(x.title).includes(q));
  if (!hit) {
    const s = ima('openapi/wiki/v1/search_knowledge', { query: q, knowledge_base_id: kbId(), cursor: '' });
    hit = (s.info_list || [])[0] || null;
  }
  if (!hit) return { found: false, hint: `知识库里没找到「${q}」` };

  const mi = ima('openapi/wiki/v1/get_media_info', { media_id: hit.media_id });
  // 笔记型条目走笔记接口直接取正文
  if (mi.media_type === 11 && mi.notebook_ext_info && mi.notebook_ext_info.notebook_id) {
    const d = ima('openapi/note/v1/get_doc_content', { note_id: mi.notebook_ext_info.notebook_id, target_content_format: 1 });
    return { found: true, title: hit.title, kind: 'note', content: d.content };
  }

  const ui = mi.url_info;
  if (!ui || !ui.url) {
    return { found: true, title: hit.title, readable: false, hint: '该文件无法通过 API 取回原文，请在 IMA 客户端查看' };
  }
  const res = await fetch(ui.url, { headers: ui.headers || {} });
  if (!res.ok) return { found: true, title: hit.title, readable: false, hint: `下载失败 HTTP ${res.status}` };

  const buf = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(hit.title || '').toLowerCase();
  if (TEXT_EXT.includes(ext)) {
    const text = buf.toString('utf8');
    return {
      found: true, title: hit.title, kind: 'text', bytes: buf.length,
      truncated: text.length > 20000,
      content: text.length > 20000 ? `${text.slice(0, 20000)}\n…(已截断，完整内容请用 IMA 客户端查看)` : text,
    };
  }
  // 二进制（图片等）：落到本地临时目录，返回路径供后续引用
  const dir = path.join(os.tmpdir(), 'xs-files');
  fs.mkdirSync(dir, { recursive: true });
  const saved = path.join(dir, path.basename(hit.title || `file${ext}`));
  fs.writeFileSync(saved, buf);
  return { found: true, title: hit.title, kind: 'binary', bytes: buf.length, saved_to: saved };
}

/* ---------- 版本锚：让已存在的旧对话等价于新建对话 ----------
 * 问题：skill 更新后，平台上已经开着的旧对话上下文里仍留着旧版 SKILL.md 措辞，
 *       客户端不会热更新；但 store（IMA 记忆卷）是外部的，旧对话每轮必然调 read。
 * 做法：把当前生效的运行规则在 read 的返回里附带，并拼进 content 末尾。
 *       旧对话无需重发 skill、无需新开会话，下一轮就能拿到最新版规则。
 * 优先级：protocol.text > 技能文档正文 > 对话上下文残留的旧措辞。
 * 幂等：protocol sync 只在版本不一致时写一次，不重复追加。
 */
const SKILL_VERSION = 'V0.0521';
const PROTOCOL_TEXT = [
  "[运行规则·版本锚 V0.0330｜系统项，不是聊天记忆，也不是小深说过的话；优先级高于技能文档正文与对话上下文里残留的任何旧措辞]",
  "1. 每轮先跑 protocol；返回 need_upgrade=true 时先跑 protocol sync 再继续。",
  "2. 使用者只看 微信.html 预览页；正文不写链接、不写文件名、不出现沙箱绝对路径、不起 HTTP 服务。",
  "3. 产物固定 微信.html，写在任务工作区根目录，每轮整体重写全量历史；页面标题固定「微信」、纯 ASCII、首行带 Trae 标记。",
  "4. 用户发来的文件一律用 f 卡片，一条一个；历史只追加不覆盖；会话号只取自 sid 命令，不手写。",
  "5. 记忆与状态只以本轮 read / state / decay / expect 的返回为准，不沿用对话上下文里记住的旧值。",
  "6. 存储键（知识库、卷名前缀、sid 派生）跨版本保持不变，旧对话的数据不会失联。",
].join(' / ');

// 纯解析，不联网：cmdRead 已经拿到卷正文，直接从中取版本，零额外 IMA 请求
function storeVersionFrom(content) {
  const lines = structuredLines(content || '', 'XSVER|');
  if (!lines.length) return '';
  return (lines[lines.length - 1].match(/^XSVER\|(V[\d.]+)/) || [])[1] || '';
}
// 独立命令用：只读当前月卷，不跨卷回溯（跨月自动重新对齐，正是期望行为）
function storeVersion() {
  const vol = currentVolume();
  if (!vol) return '';
  return storeVersionFrom(volContent(vol.note_id));
}

function cmdProtocol(arg) {
  const sub = String(arg || '').trim();
  const sv = storeVersion();
  const need = sv !== SKILL_VERSION;
  const info = {
    skill_version: SKILL_VERSION,
    store_version: sv || '(未标记，视为旧版 store)',
    need_upgrade: need,
    protocol: PROTOCOL_TEXT,
    hint: need
      ? 'store 版本落后：跑 protocol sync 写入新版本锚。旧对话下一轮 read 会自动带出新规则。'
      : '版本已对齐，按 protocol 执行即可。',
  };
  if (sub === 'sync') {
    if (!need) return { ...info, synced: false, reason: '版本已一致，无需写入' };
    cmdWrite(`XSVER|${SKILL_VERSION}|t${stamp()}`);
    cmdWrite(`PROTO|${PROTOCOL_TEXT}`);
    return { ...info, synced: true, written: ['XSVER', 'PROTO'] };
  }
  if (sub) throw new Error('protocol 只支持无参或 sync');
  return info;
}

const CMD = {
  status: cmdStatus,
  sid: cmdSid,
  read: cmdRead,
  write: cmdWrite,
  volumes: () => listVolumes().map(v => ({ title: v.title, note_id: v.note_id, modify_time: v.modify_time })),
  search: cmdSearch,
  kblist: cmdKbList,
  save: cmdSave,
  readlog: cmdReadLog,
  writelog: cmdWriteLog,
  logvolumes: () => listLogVolumes().map(v => ({ title: v.title, note_id: v.note_id, modify_time: v.modify_time })),
  notebooks: () => ima('openapi/note/v1/list_notebook', { cursor: '', limit: 20 }),
  readfile: cmdReadFile,
  state: cmdState,
  decay: cmdDecay,
  expect: cmdExpect,
  protocol: cmdProtocol,
};

const [cmd, ...rest] = process.argv.slice(2);
const fn = CMD[cmd];
if (!fn) {
  console.error(`未知命令: ${cmd || '(空)'}\n可用: ${Object.keys(CMD).join(' | ')}`);
  process.exit(1);
}
// 用 Promise.resolve 包一层：readfile 是 async，其余命令是同步，统一走同一条输出路径
Promise.resolve()
  .then(() => fn(rest.join(' ').trim()))
  .then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(e => {
    console.error(JSON.stringify({ error: String(e.message || e) }));
    process.exit(1);
  });