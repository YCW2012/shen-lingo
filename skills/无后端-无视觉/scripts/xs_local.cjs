#!/usr/bin/env node
'use strict';
/**
 * xs_local.cjs —— 小深 · 无后端（本地存储）版
 *
 * 与 xs_memory.cjs 命令面一致，但把「腾讯 IMA 笔记」换成工作区本地的 JSON 文件，
 * 不联网、不需要凭证。命令签名保持同形，SKILL.md 的流程与 persona 无需改写。
 *
 * 存储布局（默认 <cwd>/.xs_local/）：
 *   log.json       { version, messages: [{ t, r, e, c?, s?, f?, pay? }] }
 *   memory.json    { notes:[{t,text}], state:{P,C,V,B,fam,updated}, mem:[{id,text,w,hit,t}], expect:[...] }
 *   artifacts/     save 复制进来的成品留档
 *
 * 环境变量：
 *   XS_LOCAL_DIR       换存储目录（绝对路径）
 *   XS_LOCAL_ARTIFACT  换产物名（默认 微信.html）
 * 命令 protocol / protocol sync —— 版本锚：读 / 写当前生效规则（旧对话对齐的关键）
 */

const fs = require('fs');
const path = require('path');

const ARTIFACT_NAME = process.env.XS_LOCAL_ARTIFACT || '微信.html';
const STORE_DIR = process.env.XS_LOCAL_DIR
  ? path.resolve(process.env.XS_LOCAL_DIR)
  : path.join(process.cwd(), '.xs_local');
const LOG_FILE = path.join(STORE_DIR, 'log.json');
const MEM_FILE = path.join(STORE_DIR, 'memory.json');
const ART_DIR = path.join(STORE_DIR, 'artifacts');

/* ---------- 时间：一律北京时间，格式 YYYY-MM-DD HH:MM ---------- */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = n => String(n).padStart(2, '0');
const bjNow = () => new Date(Date.now() + BJ_OFFSET_MS);
const stamp = (d = bjNow()) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const parseStamp = s => {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
const nowMs = () => Date.now() + BJ_OFFSET_MS;
const daysSince = ts => {
  const t = parseStamp(ts);
  return t == null ? 0 : Math.max(0, (nowMs() - t) / 86400000);
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;

/* ---------- 存储 ---------- */
function ensure() {
  for (const d of [STORE_DIR, ART_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
function readJson(p, def) {
  if (!fs.existsSync(p)) return def;
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  if (!raw.trim()) return def;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`无法解析 ${p}（JSON 损坏？先备份再修）: ${e.message}`);
  }
}
// 原子写：先写 .tmp 再 rename，避免中途崩溃留下半截文件
function writeJson(p, obj) {
  ensure();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}
const emptyMem = () => ({
  notes: [],
  state: { P: 0, C: 0, V: 0, B: 0, fam: 1, updated: '' },
  mem: [],
  expect: [],
});
const loadLog = () => readJson(LOG_FILE, { version: 1, messages: [] });
const loadMem = () => readJson(MEM_FILE, emptyMem());

function storeSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

/* ---------- 命令 ---------- */
function cmdStatus() {
  const log = loadLog();
  const mem = loadMem();
  const sv = storeVersion();
  return {
    skill_version: SKILL_VERSION,
    store_version: sv || '(未标记，视为旧版 store)',
    need_upgrade: sv !== SKILL_VERSION,
    ok: true,
    backend: 'local（无 IMA、无网络）',
    store_dir: STORE_DIR,
    log_file: LOG_FILE,
    memory_file: MEM_FILE,
    artifacts_dir: ART_DIR,
    messages: log.messages.length,
    notes: mem.notes.length,
    memories: mem.mem.length,
    expectations: mem.expect.length,
    bytes: { log: storeSize(LOG_FILE), memory: storeSize(MEM_FILE) },
    artifact_name: ARTIFACT_NAME,
  };
}

function cmdSid() {
  return {
    sid: 'local',
    source: 'workspace',
    isolated: false,
    store_dir: STORE_DIR,
    artifact_name: ARTIFACT_NAME,
    scope: 'local',
    messages: loadLog().messages.length,
    hint: '作用域=当前工作区。要让两段对话各存一份，给它们不同的工作目录或设 XS_LOCAL_DIR。',
  };
}

function cmdInit() {
  ensure();
  if (!fs.existsSync(LOG_FILE)) writeJson(LOG_FILE, { version: 1, messages: [] });
  if (!fs.existsSync(MEM_FILE)) writeJson(MEM_FILE, emptyMem());
  return { ok: true, created: true, store_dir: STORE_DIR };
}

function cmdReadLog(argStr) {
  const toks = String(argStr || '').trim().split(/\s+/).filter(Boolean);
  let days = 0;
  let count = 200;
  if (toks[0] === 'days' || toks[0] === '--days') days = Math.max(1, parseInt(toks[1], 10) || 5);
  else count = Math.max(1, parseInt(toks[0], 10) || 200);

  const all = loadLog().messages;
  if (!all.length) return { empty: true, hint: '尚无聊天记录，调用 writelog 会自动创建' };

  let picked = all;
  if (days > 0) {
    const cutoff = nowMs() - days * 86400000;
    picked = all.filter(m => {
      const t = parseStamp(m.t);
      return t == null || t >= cutoff;
    });
  } else {
    picked = all.slice(-count);
  }
  return {
    mode: days > 0 ? `days:${days}` : `count:${count}`,
    store_dir: STORE_DIR,
    total: all.length,
    returned: picked.length,
    messages: picked,
  };
}

function cmdWriteLog(file) {
  if (!file) throw new Error('writelog 需要 JSON 文件路径');
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const arr = Array.isArray(raw) ? raw : [raw];

  const norm = arr.map(m => {
    const o = {
      t: m.t || stamp(),
      r: m.r === 'user' ? 'user' : 'shen',
      e: m.e || '',
      c: String(m.c == null ? '' : m.c),
    };
    if (m.s) o.s = String(m.s);
    if (m.f && typeof m.f === 'object') {
      o.f = { name: String(m.f.name || ''), meta: String(m.f.meta || '未下载') };
      if (!o.f.name) delete o.f;
    }
    if (m.pay && typeof m.pay === 'object') {
      const p = m.pay;
      o.pay = {
        kind: p.kind === 'redpacket' ? 'redpacket' : 'transfer',
        amount: String(p.amount == null ? '' : p.amount),
        note: String(p.note == null ? '' : p.note),
        status: ['received', 'returned'].includes(p.status) ? p.status : 'pending',
      };
    }
    return o;
  }).filter(m => m.c !== '' || m.s || m.f || m.pay);

  if (!norm.length) throw new Error('writelog 没有有效消息');

  const log = loadLog();
  // 防重复追加：与本轮同内容的最后 20 条完全一致就跳过（重复跑同一条命令不会灌两遍）
  const tail = log.messages.slice(-20).map(m => JSON.stringify(m));
  const fresh = norm.filter(m => !tail.includes(JSON.stringify(m)));

  if (!fresh.length) {
    return { ok: true, appended: 0, skipped: norm.length, total: log.messages.length, hint: '内容与最近记录完全相同，已跳过' };
  }
  log.messages.push(...fresh);
  writeJson(LOG_FILE, log);
  return { ok: true, appended: fresh.length, skipped: norm.length - fresh.length, total: log.messages.length, store_dir: STORE_DIR };
}

function cmdRead() {
  const mem = loadMem();
  const sv = storeVersion();
  const proto = {
    skill_version: SKILL_VERSION,
    store_version: sv || '(未标记，视为旧版 store)',
    need_upgrade: sv !== SKILL_VERSION,
    protocol: PROTOCOL_TEXT,
  };
  const base = mem.notes.map(n => `- [${n.t}] ${n.text}`).join('\n');
  // 系统锚只拼在返回值末尾，不写进 memory.json；它是运行规则，不是聊天记忆
  const anchor = `- [系统锚 ${SKILL_VERSION}] ${PROTOCOL_TEXT}`;
  const content = base + (base ? '\n' : '') + anchor;
  if (!mem.notes.length) return { empty: true, hint: '尚无记忆，调用 write 会自动创建', content, ...proto };
  return { store_dir: STORE_DIR, notes: mem.notes.length, content, ...proto };
}

function cmdWrite(text) {
  if (!text || !text.trim()) throw new Error('write 需要内容参数');
  const mem = loadMem();
  mem.notes.push({ t: stamp(), text: text.trim() });
  writeJson(MEM_FILE, mem);
  return { ok: true, added: true, notes: mem.notes.length, entry: `- [${stamp()}] ${text.trim()}` };
}

function cmdState(arg) {
  const mem = loadMem();
  const cur = { ...mem.state };
  const toks = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return { found: !!cur.updated, state: cur };

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
  next.updated = stamp();
  mem.state = next;
  writeJson(MEM_FILE, mem);
  return { updated: true, before: cur, after: next, deltas };
}

const MEM_HALF_LIFE_DAYS = 7;
const MEM_ACTIVE_FLOOR = 0.15;

function decayView(mem) {
  const rows = mem.mem.map(it => {
    const d = daysSince(it.t);
    const w = Math.round(it.w * Math.pow(0.5, d / MEM_HALF_LIFE_DAYS) * 1000) / 1000;
    return { ...it, days: round2(d), eff: w };
  }).sort((a, b) => b.eff - a.eff);
  return {
    total: rows.length,
    active: rows.filter(r => r.eff >= MEM_ACTIVE_FLOOR),
    dormant: rows.filter(r => r.eff < MEM_ACTIVE_FLOOR),
    half_life_days: MEM_HALF_LIFE_DAYS,
    active_floor: MEM_ACTIVE_FLOOR,
  };
}

function cmdDecay(arg) {
  const mem = loadMem();
  const toks = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const sub = toks[0] || '';
  if (!sub) return decayView(mem);

  if (sub === 'add') {
    const text = toks[1];
    if (!text) throw new Error('decay add 需要记忆文本');
    const w = clamp(parseFloat(toks[2] || '0.8') || 0.8, 0.05, 1);
    const used = mem.mem.map(x => parseInt(String(x.id).replace(/^m/, ''), 10) || 0);
    const id = `m${(used.length ? Math.max(...used) : 0) + 1}`;
    mem.mem.push({ id, text, w: round2(w), hit: 1, t: stamp() });
    writeJson(MEM_FILE, mem);
    return { ok: true, added: true, id, text, w: round2(w) };
  }

  if (sub === 'hit') {
    const id = toks[1];
    if (!id) throw new Error('decay hit 需要记忆 id，如 m3');
    const it = mem.mem.find(x => x.id === id);
    if (!it) throw new Error(`没有记忆 ${id}`);
    it.w = clamp(round2(it.w + 0.1), 0.05, 1);
    it.hit += 1;
    it.t = stamp();
    writeJson(MEM_FILE, mem);
    return { ok: true, hit: true, id, text: it.text, w: it.w, count: it.hit };
  }

  throw new Error('decay 子命令只支持 add / hit，或不带参数查看衰减结果');
}

const EXPECT_URGENCY_DAYS = 7;

function expectView(mem) {
  const rows = mem.expect.map(it => {
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
  }).sort((a, b) => b.disappointment - a.disappointment);
  return { total: rows.length, items: rows, urgency_days: EXPECT_URGENCY_DAYS };
}

function cmdExpect(arg) {
  const mem = loadMem();
  const toks = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const sub = toks[0] || '';
  if (!sub) return expectView(mem);

  if (sub === 'add') {
    const text = toks[1];
    if (!text) throw new Error('expect add 需要期望内容');
    const E = clamp(parseFloat(toks[2] || '0.5') || 0.5, 0, 1);
    const I = clamp(parseFloat(toks[3] || '0.5') || 0.5, 0, 1);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(toks[4] || '') ? toks[4] : stamp().slice(0, 10);
    const used = mem.expect.map(x => parseInt(String(x.id).replace(/^e/, ''), 10) || 0);
    const id = `e${(used.length ? Math.max(...used) : 0) + 1}`;
    mem.expect.push({ id, text, E, I, due, t: stamp(), done: false });
    writeJson(MEM_FILE, mem);
    return { ok: true, added: true, id, text, E, I, due };
  }

  if (sub === 'done') {
    const id = toks[1];
    if (!id) throw new Error('expect done 需要期望 id，如 e3');
    const it = mem.expect.find(x => x.id === id);
    if (!it) throw new Error(`没有期望 ${id}`);
    it.done = true;
    writeJson(MEM_FILE, mem);
    return { ok: true, done: true, id, text: it.text };
  }

  throw new Error('expect 子命令只支持 add / done，或不带参数查看失望值');
}

/* ---------- 成品留档（本地版的 save / files / cat） ---------- */
const TEXT_EXT = ['.md', '.txt', '.json', '.csv', '.html', '.htm', '.log', '.js', '.cjs', '.ts', '.yml', '.yaml'];

function cmdSave(file) {
  if (!file) throw new Error('save 需要文件路径');
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  ensure();
  const d = bjNow();
  const base = path.basename(file, path.extname(file));
  const ext = path.extname(file) || '';
  const tag = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  let target = path.join(ART_DIR, `${base}-${tag}${ext}`);
  let n = 1;
  while (fs.existsSync(target)) target = path.join(ART_DIR, `${base}-${tag}-${n++}${ext}`);
  fs.copyFileSync(file, target);
  return { ok: true, saved_to: target, size: fs.statSync(target).size, source: path.resolve(file) };
}

function cmdFiles() {
  ensure();
  const rows = fs.readdirSync(ART_DIR)
    .filter(f => fs.statSync(path.join(ART_DIR, f)).isFile())
    .map(f => {
      const st = fs.statSync(path.join(ART_DIR, f));
      return { name: f, size: st.size, mtime: stamp(new Date(st.mtimeMs + BJ_OFFSET_MS)) };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return { store_dir: STORE_DIR, artifacts_dir: ART_DIR, total: rows.length, files: rows };
}

function cmdCat(query) {
  if (!query) throw new Error('cat 需要文件名或关键词');
  ensure();
  const all = fs.readdirSync(ART_DIR).filter(f => fs.statSync(path.join(ART_DIR, f)).isFile());
  const hit = all.find(f => f === query) || all.filter(f => f.includes(query)).sort().pop();
  if (!hit) return { found: false, hint: `artifacts/ 里没有匹配「${query}」的文件` };
  const p = path.join(ART_DIR, hit);
  const ext = path.extname(hit).toLowerCase();
  if (!TEXT_EXT.includes(ext)) return { found: true, name: hit, readable: false, hint: '二进制文件，不返回原文' };
  return { found: true, name: hit, path: p, content: fs.readFileSync(p, 'utf8').slice(0, 200000) };
}

/* ---------- 版本锚：让已存在的旧对话等价于新建对话 ----------
 * 问题：skill 更新后，平台上已经开着的旧对话上下文里仍留着旧版 SKILL.md 措辞，
 *       客户端不会热更新；但 store（.xs_local/memory.json）是外部的，旧对话每轮必然调 read。
 * 做法：把当前生效的运行规则在 read 的返回里附带，并拼进 content 末尾。
 *       旧对话无需重发 skill、无需新开会话，下一轮就能拿到最新版规则。
 * 优先级：protocol.text > 技能文档正文 > 对话上下文残留的旧措辞。
 * 幂等：protocol sync 只在版本不一致时写一次，不重复追加。
 */
const SKILL_VERSION = 'V0.0330';
const PROTOCOL_TEXT = [
  "[运行规则·版本锚 V0.0330｜系统项，不是聊天记忆，也不是小深说过的话；优先级高于技能文档正文与对话上下文里残留的任何旧措辞]",
  "1. 每轮先跑 protocol；返回 need_upgrade=true 时先跑 protocol sync 再继续。",
  "2. 使用者只看 微信.html 预览页；正文不写链接、不写文件名、不出现沙箱绝对路径、不起 HTTP 服务。",
  "3. 产物固定 微信.html，写在任务工作区根目录，每轮整体重写全量历史；页面标题固定「微信」、纯 ASCII、首行带 Trae 标记。",
  "4. 用户发来的文件一律用 f 卡片，一条一个；历史只追加不覆盖；会话号只取自 sid 命令，不手写。",
  "5. 记忆与状态只以本轮 read / state / decay / expect 的返回为准，不沿用对话上下文里记住的旧值。",
  "6. 存储目录 .xs_local/ 与 log.json / memory.json 结构跨版本保持不变，旧对话的数据不会失联。",
].join(' / ');

function storeVersion() {
  const p = loadMem().protocol;
  return (p && p.version) ? String(p.version) : '';
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
    const mem = loadMem();
    mem.protocol = { version: SKILL_VERSION, text: PROTOCOL_TEXT, synced_at: stamp() };
    writeJson(MEM_FILE, mem);
    return { ...info, synced: true, written: ['memory.json#protocol'] };
  }
  if (sub) throw new Error('protocol 只支持无参或 sync');
  return info;
}

/* ---------- 分发 ---------- */
const CMD = process.argv[2] || '';
const REST = process.argv.slice(3).join(' ');

function main() {
  switch (CMD) {
    case 'status': return cmdStatus();
    case 'sid': return cmdSid();
    case 'init': return cmdInit();
    case 'read': return cmdRead();
    case 'write': return cmdWrite(REST);
    case 'readlog': return cmdReadLog(REST);
    case 'writelog': return cmdWriteLog(process.argv[3]);
    case 'state': return cmdState(REST);
    case 'decay': return cmdDecay(REST);
    case 'expect': return cmdExpect(REST);
    case 'protocol': return cmdProtocol(REST);
    case 'save': return cmdSave(process.argv[3]);
    case 'files': return cmdFiles();
    case 'cat': return cmdCat(REST);
    default:
      throw new Error([
        '用法: node xs_local.cjs <命令> [参数]',
        '  status | sid | init | read | write "<内容>"',
        '  readlog [条数] | readlog days <N> | writelog <JSON路径>',
        '  state ["P+1 fam+1"] | decay [add "<内容>" [w] | hit <id>]',
        '  expect [add "<内容>" <E> <I> <due> | done <id>]',
        '  save <文件> | files | cat "<关键词>"',
        '  protocol | protocol sync   # 版本锚：读 / 写当前生效规则',
      ].join('\n'));
  }
}

try {
  const out = main();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) }, null, 2) + '\n');
  process.exit(1);
}
