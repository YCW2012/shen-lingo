#!/usr/bin/env node
'use strict';
/**
 * 小深 · 聊天记录 → 自包含 HTML
 *
 * 用法:
 *   node build_html.cjs --log <chatlog.json> --out <out.html> [--title "..."] [--tags <tags.txt>] [--max-messages 2000]
 *
 * --log  可为 xs_memory.cjs readlog 的完整输出（自动取 .messages），也可为纯消息数组
 * --tags 纯文本，逐行写进页面底部 SYSTEM-TAGS 注释块；不传则留空
 * --max-messages  单页内嵌消息上限（默认 2000）。超出时只渲染最近 N 条，
 *                 并在页首插一条提示（更早记录仍在 IMA 笔记卷里，未丢失）。
 *                 理由：内嵌体积随条数线性增长，无上限时页面会膨胀到几 MB，
 *                 拖慢写出与首屏渲染；设上限把「页面体积」与「记录总量」解耦。
 *
 * 消息对象: { t:"2026-10-01 00:20", r:"user"|"shen", e:"害羞", c:"文本", s:"表情描述",
 *            f:{ name:"文件名.pdf", meta:"1.2M 未下载" } }
 *   - f 存在时渲染为微信「文件」卡片气泡（优先于 c / s）
 *   - s 存在时渲染为表情包气泡（不渲染 c）
 *   - 头像与表情包全部内联 base64，成品页面零外部请求
 *
 * 按天折叠（默认展开最近 3 天）由页面内联脚本完成，不在本脚本内分块：
 *   分块结构交给运行时生成，模板不执行脚本时页面即为平铺全量记录，不会隐藏任何数据。
 */
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.join(__dirname, '..');
const STICKER_B64 = path.join(SKILL_DIR, 'assets', 'stickers.b64.json');
const TEMPLATE = path.join(SKILL_DIR, 'assets', 'chat-template.html');

/* 情绪 → 表情描述词优先级表；运行时按实际存在的表情过滤 */
const EMOTION_STICKER = {
  '害羞': ['害羞', '偷瞄', '微笑', '乖巧'],
  '开心': ['开心', '嘻嘻', '眯眼笑', '傻笑', '微笑', '赞'],
  '爱意': ['双眼冒爱心', '抱抱', '贴', '喵', '微笑'],
  '难过': ['哭', '委屈巴巴', '垂头丧气', '自闭', '大哭'],
  '生气': ['生气', '气鼓鼓', '哼', '略'],
  '傲娇': ['略', '我要闹啦', '哼', '坏笑'],
  '困倦': ['打哈欠', '晚安', '生无可恋', '自闭'],
  '惊讶': ['惊', '瞪大眼睛', '惊喜', '？'],
  '疑惑': ['？', '思考', '仔细看', '探头'],
  '无语': ['阿巴阿巴阿巴', '噎住', '自闭', '生无可恋', '？'],
  '可爱': ['喵', '乖巧', '探头', '咪', '微笑'],
  '平静': ['微笑', '仔细看', 'OK', '辛苦了', '看地板'],
  '得意': ['坏笑', '嘿嘿嘿', '嘻嘻', '略'],
};
const ALIAS = {
  shy: '害羞', happy: '开心', joy: '开心', love: '爱意', sad: '难过', cry: '难过',
  angry: '生气', pout: '傲娇', tsundere: '傲娇', sleepy: '困倦', tired: '困倦',
  shock: '惊讶', surprise: '惊讶', confuse: '疑惑', speechless: '无语',
  cute: '可爱', calm: '平静', smug: '得意',
};
const DEFAULT_EMOTION = '平静';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// 交付件一律输出纯 ASCII：所有非 ASCII 字符转成 &#x 实体。
// 原因：云端沙箱与预览器的编码处理不可控——UTF-8 中文一旦被按 Latin-1 解读就是满屏乱码，
// 而 meta charset 未必被尊重。实体化后文件是 100% ASCII，无论被当成哪种编码读都显示正常。
// 代价是体积略增（每个中文字符约 8 字节），不影响阅读。
const toAsciiEntities = s => String(s).replace(/[\u0080-\uFFFF]/g, c => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`);

const pad = n => String(n).padStart(2, '0');

function emotionKey(raw) {
  const k = String(raw || '').trim();
  if (!k) return DEFAULT_EMOTION;
  if (EMOTION_STICKER[k]) return k;
  return ALIAS[k.toLowerCase()] || DEFAULT_EMOTION;
}

// excludeDesc：指定一张必须避开的图（用来保证头像和表情包不同图）。
// 先在同情绪池里避开，池里只剩这一张就退到全池避开。
function pickSticker(stickers, emotion, seed, excludeDesc) {
  const list = EMOTION_STICKER[emotionKey(emotion)] || [];
  let pool = list.filter(d => stickers[d] && d !== excludeDesc);
  if (!pool.length) pool = Object.keys(stickers).filter(d => d !== excludeDesc);
  return pool.length ? pool[(seed || 0) % pool.length] : '';
}

// 一律输出绝对日期（几月几号几点几分），不用「今天 / 昨天 / 刚刚」这类相对词。
// 原因：相对词要拿「读取时刻」当基准，而页面会被反复打开、跨时区打开、被别的会话引用，
// 基准一变标签就骗人（非东八区机器上，北京时间 00:00–08:00 会被判成前一天）。
// 绝对日期只依赖写入时固化的那个值，任何时候打开都是同一句话。
function timeLabel(ts) {
  const m = String(ts || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return String(ts || '');
  const [, , mo, d, hh, mm] = m;
  return `${Number(mo)}月${Number(d)}日 ${hh}:${mm}`;
}
const dateKey = ts => (String(ts || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];

// 时间分隔线不只在跨天时打：同一段对话里隔了 20 分钟以上（往前跳也算，历史记录里
// 常出现跨天或补录导致的回跳），也另起一条，否则整页历史全挤在最早那条时间戳下面。
const stampOf = ts => {
  const m = String(ts || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0;
};
const GAP_MS = 20 * 60 * 1000;

// 微信「文件」卡片底部的来源行图标（微信电脑版小绿图标），纯 ASCII 路径，直接内联。
const FILE_SRC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#5ec75f" d="M9.4 2.9C5.2 2.9 1.8 5.8 1.8 9.3c0 2 1.1 3.7 2.9 4.9l-.7 2.2 2.5-1.3c.9.2 1.8.4 2.8.4.2 0 .4 0 .6-.1a5.7 5.7 0 0 1-.2-1.4c0-3.4 3.2-6.1 7.2-6.1h.5C16.6 4.6 13.3 2.9 9.4 2.9z"/><path fill="#fff" d="M16.4 8.7c-3.6 0-6.5 2.3-6.5 5.1 0 1.7 1 3.2 2.5 4.1l-.6 1.9 2.2-1.1c.8.2 1.6.3 2.4.3 3.6 0 6.5-2.3 6.5-5.1s-2.9-5.2-6.5-5.2z"/></svg>';

// 文件卡片内部结构。注意标签之间的换行缩进：卡片 CSS 已把 white-space 改回 normal，
// 所以这里的换行不会像普通气泡那样被渲染成空行。
// 微信发文件时，卡片只显示「不带扩展名的文件名」，扩展名跑在右边的类型图标里。
// 把 .md 塞进标题会把「小深技能包-使用说明.m」硬折成两行，所以单独抽出来给图标用。
const extOf = name => {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toUpperCase() : '';
};
const stripExt = name => String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
// 图标底色固定微信红 #e14949，不按后缀换色（用户明确要求：md 也是红图标）。
const FILE_ICON_COLOR = '#e14949';
// 文件图标底色一律微信红（用户 10/03 明确：md 也是红图标，别按后缀换色）。
// 这里原先有一张按后缀配色的表（PDF 红 / DOC 蓝 / XLS 绿…），写完就没人读——
// 用户否决了按后缀变色，表留着只会让后来改样式的人以为改了会生效。2026-10-04 删掉。
function fileCard(m) {
  const f = m.f && typeof m.f === 'object' ? m.f : {};
  const raw = f.name || m.c || '文件';
  const ext = extOf(raw) || 'FILE';
  const name = esc(stripExt(raw));
  const meta = esc(f.meta || '未下载');
  return [
    '      <div class="file-head">',
    '        <div class="file-info">',
    `          <div class="file-name">${name}</div>`,
    `          <div class="file-meta">${meta}</div>`,
    '        </div>',
    `        <span class="file-icon" style="background:${FILE_ICON_COLOR}"><i>${esc(ext)}</i></span>`,
    '      </div>',
    '      <div class="file-src">',
    `        ${FILE_SRC_SVG}`,
    '        <span>微信电脑版</span>',
    '      </div>',
  ].join('\n');
}

// 红包 / 转账卡片。字段：pay = { kind: 'redpacket'|'transfer', amount, note, status }
// status: pending（默认）| received | returned；r 决定视角（她发给你 / 你发给她）
//
// 图标全部重画（2026-10-04 用户给了 3 张真机截图，逐像素采样）：
//   转账＝白描边圆（圆径 38）＋上下两条反向箭头；已收款换成对勾。
//   红包＝红封套（身 #e14949 / 封盖 #fa5151 / 金印 #ffcf33）；已领完换成褐色封套。
//   采样值：封套真身 36×44；金印直径约 15。
// ---- 转账圆圈：真机逐像素（2026-10-04 二次修正）----
//   圆环 cx=cy=19 r=17 stroke=2（真机外径 36、环粗 2）
//   上下两条横杠 y=16.5 / 21.5，x 10.6..27.4，粗 2（两杠只隔 5px，不是上一版的 8.8px）
//   上杠「左端」接一条向右上翘的单侧倒刺 -> 读作朝左的箭头
//   下杠「右端」接一条向左下坠的单侧倒刺 -> 读作朝右的箭头
//   （上一版画成双侧 V 形箭头、两杠又拉太开，所以不像）
const SVG_TF_RING =
  '<circle cx="19" cy="19" r="17" fill="none" stroke="currentColor" stroke-width="2"/>';
const TF_ICON_PENDING =
  '<svg viewBox="0 0 38 38" aria-hidden="true">' + SVG_TF_RING +
  '<path d="M27.5 16 H10.5 M12.0 15.6 L16.5 11.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M10.5 22 H27.5 M26.0 22.4 L21.5 26.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const TF_ICON_DONE =
  '<svg viewBox="0 0 38 38" aria-hidden="true">' + SVG_TF_RING +
  '<path d="M11.8 19.4 L16.7 24.3 L26.2 14.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
// ---- 未拆红包：真机金印中间是人民币符号「¥」，不是「福」----
const RP_ICON =
  '<svg viewBox="0 0 36 44" aria-hidden="true">' +
  '<rect x="0" y="0" width="36" height="44" rx="3" fill="#e14949"/>' +
  '<path d="M0 3 A3 3 0 0 1 3 0 H33 A3 3 0 0 1 36 3 V17.5 C36 23.2 27.5 26 18 26 C8.5 26 0 23.2 0 17.5 Z" fill="#fa5151"/>' +
  '<circle cx="18" cy="21" r="7.6" fill="#ffcf33"/>' +
  '<text x="18" y="24.7" text-anchor="middle" font-size="10" font-weight="700" fill="#c8352c">&#xA5;</text>' +
  '</svg>';
// ---- 已拆开（已领完 / 已退还）----
//   真机逐像素：封身 x0..35、底 y43.5；封盖是一枚「上下都浅弧」的透镜，
//   中间最厚 13.7px、两侧只有 8px，左右边近乎垂直；
//   金印 圆心(17.5,17.5) r6.3，画在封盖「之前」，才会从封盖下缘露出来。
//   ★ 上一版把封身画成整块圆角矩形（顶边跟封盖顶边齐平），
//     结果封身的两个圆角从封盖肩部两侧冒出来 = 用户说的「左上右上多两个圆角」。
//     现在封身顶边压到 y=6，完全藏进封盖里，只露出下半截。
const RP_ICON_DONE =
  '<svg viewBox="0 0 36 44" aria-hidden="true">' +
  '<path d="M0 6 H36 V40.5 A3.5 3.5 0 0 1 32.5 44 H3.5 A3.5 3.5 0 0 1 0 40.5 Z" fill="#9f6031"/>' +
  '<circle cx="17.5" cy="17.5" r="6.3" fill="#c9b084"/>' +
  // 封盖下缘压下来的柔和阴影，真机在金印上沿能看到一块「V」形压暗
  '<ellipse cx="17.5" cy="14.2" rx="4.0" ry="4.4" fill="#997152" opacity=".28"/>' +
  '<path d="M0 3.2 Q18 -2.4 36 3.2 L36 11 C30 15.2 6 15.2 0 11 Z" fill="#997152"/>' +
  '</svg>';

// 尖角：内联 SVG，由 4 个 1px 宽的整数矩形拼出列高 2/4/6/8 的阶梯。
// 为什么不用 CSS border 三角 / <path> 三角：45° 斜边会被抗锯齿糊出一条
// 「底色 + 背景色各半」的混色像素，在深色背景上就是尖角外沿那条深色描边
// （用户截图圈出来的正是它）；而 <path> 的尖端是一个「点」，光栅化取整时
// 左侧那一列还会被四舍五入掉（凸出只剩 3px）。整数矩形没有斜线，两个问题都不存在。
// ★ 不要加 shape-rendering="crispEdges"：实测它会让 SVG 内容整体右移 1px，
//   左侧尖角变 3px、右侧 4px，左右不对称。
// 颜色不写在这里：由 CSS 用 var(--pay-bg) / var(--wx-bubble-*) 给 fill，保证与底色同源。
// 左右两侧用互为镜像的整数坐标直接生成，不用 transform:scaleX(-1)（镜像会重新采样）。
function tailRects(right) {
  // 左尖：从外到内，列高 2 / 4 / 6 / 8；右尖是它的镜像
  const cols = [[0, 3, 2], [1, 2, 4], [2, 1, 6], [3, 0, 8]];
  return cols
    .map(([x, y, h]) => {
      const cx = right ? 3 - x : x;
      return `<rect x="${cx}" y="${y}" width="1" height="${h}"/>`;
    })
    .join('');
}
function tailSvg(cls, right) {
  return `<svg class="tail ${cls}" viewBox="0 0 4 8" aria-hidden="true">` +
         `${tailRects(right)}</svg>`;
}
const TAIL_PAY_L = tailSvg('tp', false);
const TAIL_PAY_R = tailSvg('tp', true);
const TAIL_TB_L = tailSvg('tb', false);
const TAIL_TB_R = tailSvg('tb', true);

// 卡片是否已「完成」状态（已收款 / 已退还）。给气泡挂 done 类用，
// 让 CSS 不必依赖 :has() 也能把尖角颜色切到 --pay-bg 的完成态。
function payIsDone(m) {
  const p = m.pay && typeof m.pay === 'object' ? m.pay : {};
  const st = String(p.status || 'pending');
  return st === 'received' || st === 'returned';
}

function payCard(m) {
  const p = m.pay && typeof m.pay === 'object' ? m.pay : {};
  const kind = p.kind === 'transfer' ? 'transfer' : 'redpacket';
  const amount = String(p.amount == null ? '' : p.amount);
  const status = String(p.status || 'pending');
  const done = status === 'received' || status === 'returned';
  const mine = m.r === 'user'; // 你发出去的

  if (kind === 'transfer') {
    // 状态文案照真机：待你收款 / 等待对方收款 / 已收款 / 已被接收 / 已退还
    let sub;
    if (status === 'received') sub = mine ? '\u5df2\u88ab\u63a5\u6536' : '\u5df2\u6536\u6b3e';
    else if (status === 'returned') sub = '\u5df2\u9000\u8fd8';
    else sub = mine ? '\u7b49\u5f85\u5bf9\u65b9\u6536\u6b3e' : '\u5f85\u4f60\u6536\u6b3e';
    // 单行输出：多行缩进会在 .bubble 的 white-space:pre-wrap 下变成真实空行，把卡片撑高
    return `      <div class="wx-pay tf${done ? ' done' : ''}"><div class="pay-top">` +
      `<span class="pay-ico tf-ico">${done ? TF_ICON_DONE : TF_ICON_PENDING}</span>` +
      `<span class="pay-col"><span class="pay-amt">&yen;${esc(amount)}</span>` +
      `<span class="pay-sub">${esc(p.note || sub)}</span></span>` +
      `</div><div class="pay-src">\u5fae\u4fe1\u8f6c\u8d26</div></div>`;
  }

  // 红包：标题下面按状态挂第二行——真机「已领完」那张就是「标题 + 已被领完」两行，
  // 而左下角的来源小字始终是「微信红包」，不随状态改写（上一版把它改成「已领取」是错的）。
  const title = p.note || '\u606d\u559c\u53d1\u8d22\uff0c\u5927\u5409\u5927\u5229';
  let line2 = '';
  if (status === 'received') line2 = mine ? '\u5df2\u88ab\u9886\u5b8c' : '\u5df2\u9886\u53d6';
  else if (status === 'returned') line2 = '\u5df2\u9000\u8fd8';
  // 同上：单行输出
  return `      <div class="wx-pay rp${done ? ' done' : ''}"><div class="pay-top">` +
    `<span class="pay-ico rp-ico">${done ? RP_ICON_DONE : RP_ICON}</span>` +
    `<span class="pay-col"><span class="pay-title">${esc(title)}</span>` +
    (line2 ? `<span class="pay-sub">${line2}</span>` : '') +
    `</span></div><div class="pay-src">\u5fae\u4fe1\u7ea2\u5305</div></div>`;
}

// 系统提示条（她领取/被领取之类）：把「红包」「转账」两词染成微信橙
function sysNote(m) {
  const raw = String(m.sys || m.c || '');
  return esc(raw).replace(/(红包|转账)/g, '<em>$1</em>');
}

function render(messages, stickers) {
  const pool = new Map(); // 描述词 -> 类名；保证同一张图全页只内联一次
  const clsOf = desc => {
    if (!desc || !stickers[desc]) return '';
    if (pool.has(desc)) return pool.get(desc);
    const cls = `xs-img-${pool.size}`;
    pool.set(desc, cls);
    return cls;
  };

  const out = [];
  let lastDate = null;
  let lastStamp = 0;
  let leftSeed = 0;

  for (const m of messages) {
    const ts = m.t || '';
    const dk = dateKey(ts);
    const stamp = stampOf(ts);
    if (dk && (dk !== lastDate || (stamp && lastStamp && Math.abs(stamp - lastStamp) >= GAP_MS))) {
      out.push(`  <div class="time">${esc(timeLabel(ts))}</div>`);
      lastDate = dk;
    }
    if (stamp) lastStamp = stamp;

    // 样式自查页的分组标题：给一段消息起个名字。正常对话日志没有 h 字段，不会渲染出来。
    if (m.h) {
      out.push(`  <div class="grp">${esc(String(m.h))}</div>`);
      continue;
    }

    if (m.sys) {
      out.push('  <div class="row sys">');
      out.push(`    <div class="sys-note">${sysNote(m)}</div>`);
      out.push('  </div>');
      continue;
    }

    if (m.r === 'user') {
      // 表情包：右对齐，头像排在图片**后面**（flex 顺序即视觉顺序），微信就是这么排的
      if (m.s) {
        const mine = clsOf(pickSticker(stickers, '', 997, ''));
        out.push('  <div class="row right sticker">');
        out.push(`    <div class="sticker ${mine}" role="img" aria-label="${esc(String(m.s))}"></div>`);
        out.push('  </div>');
        continue;
      }
      out.push('  <div class="row right">');
      if (m.pay) {
        out.push(`    <div class="bubble pay${payIsDone(m) ? ' done' : ''}">`);
        out.push(payCard(m) + TAIL_PAY_R);
        out.push('    </div>');
      } else if (m.f) {
        out.push('    <div class="bubble file">');
        out.push(fileCard(m) + TAIL_TB_R);
        out.push('    </div>');
      } else {
        out.push(`    <div class="bubble">${esc(m.c)}${TAIL_TB_R}</div>`);
      }
      // 我方（右侧）**不出头像**：模板顶部硬约束第 3 条 + 用户 2026-10-04 明确要求。
      // 曾经在右侧挂过一个灰底「阿」字占位头像，是误读需求，已删；同理尖角朝右。
      out.push('  </div>');
      continue;
    }

    const emo = emotionKey(m.e);

    // 红包/转账 > 文件 > 表情 > 文本：金额类消息最优先，且永远不与文件同条。
    if (m.pay) {
      const payAvatarCls = clsOf(pickSticker(stickers, emo, leftSeed));
      out.push(`  <div class="row left" data-emotion="${esc(emo)}">`);
      out.push(`    <span class="avatar${payAvatarCls ? ' ' + payAvatarCls : ''}"></span>`);
      out.push(`    <div class="bubble pay${payIsDone(m) ? ' done' : ''}">`);
      out.push(payCard(m) + TAIL_PAY_L);
      out.push('    </div>');
      out.push('  </div>');
      leftSeed++;
      continue;
    }

    // 文件卡片优先于文本/表情：她发成品文件时用卡片样式，结构对齐微信。
    if (m.f) {
      const fileAvatarCls = clsOf(pickSticker(stickers, emo, leftSeed));
      out.push(`  <div class="row left" data-emotion="${esc(emo)}">`);
      out.push(`    <span class="avatar${fileAvatarCls ? ' ' + fileAvatarCls : ''}"></span>`);
      out.push('    <div class="bubble file">');
      out.push(fileCard(m) + TAIL_TB_L);
      out.push('    </div>');
      out.push('  </div>');
      leftSeed++;
      continue;
    }

    // 表情包先定；头像必须与表情包不同图——同一张图既当头像又当表情包会很别扭。
    // 所以挑头像时显式排除表情包那张：优先同情绪池，池里只剩它一张就退到全池避开。
    let stDesc = String(m.s || '');
    if (stDesc && !stickers[stDesc]) stDesc = pickSticker(stickers, emo, leftSeed);
    const stCls = stDesc ? clsOf(stDesc) : '';
    if (m.s && !stCls) continue; // 表情缺失时宁可不发，也不留破图

    const avatarCls = clsOf(pickSticker(stickers, emo, leftSeed, stDesc));
    const avatar = `<span class="avatar${avatarCls ? ' ' + avatarCls : ''}"></span>`;

    if (m.s) {
      out.push(`  <div class="row left sticker" data-emotion="${esc(emo)}">`);
      out.push(`    ${avatar}`);
      out.push(`    <div class="sticker ${stCls}" role="img" aria-label="${esc(stDesc)}"></div>`);
      out.push('  </div>');
    } else {
      out.push(`  <div class="row left" data-emotion="${esc(emo)}">`);
      out.push(`    ${avatar}`);
      out.push(`    <div class="bubble">${esc(m.c)}${TAIL_TB_L}</div>`);
      out.push('  </div>');
    }
    leftSeed++;
  }

  const assets = [...pool.entries()]
    .map(([desc, cls]) => `  .${cls}{background-image:url("${stickers[desc]}")}`)
    .join('\n');

  return { rows: out.join('\n'), assets, inlined: pool.size };
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : '';
}

const logPath = arg('log');
const outPath = arg('out');
// 标题统一固定为「微信」（用户 2026-10-03 定的规矩）：不传 --title 也用它，别自造标题
const title = arg('title') || '微信';
const tagsPath = arg('tags');
const maxMessages = Math.max(1, parseInt(arg('max-messages'), 10) || 2000);

if (!logPath || !outPath) {
  console.error('用法: node build_html.cjs --log <chatlog.json> --out <out.html> [--title "..."] [--tags <tags.txt>] [--max-messages 2000]');
  process.exit(1);
}

// 统一剥掉 UTF-8 BOM：Windows 侧用 PowerShell 写出的 JSON 常带 BOM，JSON.parse 会直接抛错
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const raw = readJson(logPath);
const messages = Array.isArray(raw) ? raw : (raw.messages || []);
const stickers = readJson(STICKER_B64);
const tpl = fs.readFileSync(TEMPLATE, 'utf8');

let tags = '';
if (tagsPath && fs.existsSync(tagsPath)) {
  tags = fs.readFileSync(tagsPath, 'utf8').trim().split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

// 超阈值降级：只内嵌最近 N 条，页首插一条提示。更早记录不删——它们仍在 IMA 笔记卷里，
// 只是不进本页；页面是视图，卷才是权威存储。
// 若输入是 readlog 的完整输出（带 total），用它当「累计条数」，否则以实际消息数为准。
const upstreamTotal = (!Array.isArray(raw) && Number.isFinite(Number(raw.total))) ? Number(raw.total) : 0;
const totalMessages = Math.max(messages.length, upstreamTotal);
const truncated = totalMessages > maxMessages;
const rendered = truncated ? messages.slice(-maxMessages) : messages;

const { rows, assets, inlined } = render(rendered, stickers);

const omitted = totalMessages - rendered.length;
const notice = truncated
  ? `  <div class="notice">本页内嵌 ${rendered.length} 条，累计 ${totalMessages} 条，更早的 ${omitted} 条未收入本页。完整记录仍在 IMA 聊天记录卷中，未丢失，需要时可用 search_note 检索。</div>`
  : '';
const body = notice ? `${notice}\n\n${rows}` : rows;

const html = tpl
  .replace(/__TITLE__/g, esc(title))
  .replace(/__ASSETS__/g, assets)
  .replace(/__MESSAGES__/g, body)
  .replace(/__SYSTEM_TAGS__/g, tags);

// 交付前结构自检：占位符没替换干净、或 <main> 里没内容，都说明生成已经坏了，宁可不交付
const leftover = html.match(/__[A-Z_]+__/g);
const mainBody = (html.match(/<main[\s\S]*?<\/main>/) || [''])[0];
const mainEmpty = !/<div class="row /.test(mainBody);
if (leftover || mainEmpty) {
  console.error(JSON.stringify({
    ok: false,
    error: leftover ? 'placeholder_not_replaced' : 'main_is_empty',
    leftover: leftover || [],
  }, null, 2));
  process.exit(1);
}

// 默认实体化；--raw 可关掉（本机直接看、想保留中文原字符时用）
// 注意编码：实体化后是纯 ASCII，用 ascii 写没问题；--raw 保留中文，必须用 utf8，
// 否则非 ASCII 字符会被 ascii 编码写成问号。
const rawMode = process.argv.includes('--raw');
const finalHtml = rawMode ? html : toAsciiEntities(html);

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, finalHtml, rawMode ? 'utf8' : 'ascii');

const nonAscii = (finalHtml.match(/[^\x00-\x7F]/g) || []).length;
const kb = (Buffer.byteLength(finalHtml, 'utf8') / 1024).toFixed(1);
console.log(JSON.stringify({
  ok: true, out: path.resolve(outPath), messages: totalMessages,
  rendered: rendered.length, truncated, omitted, max_messages: maxMessages,
  inlined_images: inlined, ascii_only: nonAscii === 0, non_ascii_chars: nonAscii, kb: Number(kb),
}, null, 2));