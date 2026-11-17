/*
 * 剪藏助手 (sy-clip) —— 思源笔记插件
 * 粘贴链接（可多行） → 抓取正文 → AI 整理（标题/摘要/标签/分类） → 存进思源
 *
 * 设计要点
 *  - 抓取 / 模型调用 / 图片下载 全走内核 /api/network/forwardProxy，前端不吃 CORS
 *  - 目录位置交给思源的 filetree API（createDocWithMd 按 hPath 落盘，层级自动建/复用）
 *  - 可写入属性视图数据库：先建文档，再用 /av/addAttributeViewBlocks 绑行，
 *    最后 /av/batchSetAttributeViewBlockAttrs 写列
 *  - 解析两层：内置站点规则（meta / 选择器）优先，未命中走通用正文引擎
 */
const { Plugin, Dialog, showMessage, fetchPost, openTab } = require("siyuan");

/* ------------------------------------------------------------------ 图标 */
const ICON_SYMBOL = `<symbol id="iconClipIn" viewBox="0 0 32 32">
<path d="M7 4h13l6 6v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
<path d="M20 4v6h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
<path d="M10 17h12M10 22h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</symbol>`;

/* -------------------------------------------------------------- 默认配置 */
const DEFAULT_SETTINGS = {
  notebook: "",
  pathTemplate: "/Clippings/{{title}}",
  useAI: true,
  ai: { mode: "siyuan", provider: "", model: "", baseURL: "", apiKey: "" },
  promptTemplate:
    "请阅读下面这篇网页正文，整理成可以长期归档的中文笔记元数据。\n" +
    "要求：\n" +
    "- title：12–24 字中文标题，概括内容，不要照抄原文开头，不要加引号书名号或句号。\n" +
    "- summary：3 条要点，每条不超过 45 字，按重要程度排序。\n" +
    "- tags：3–5 个中英文标签，多词用蛇形命名法（如 local_first_search），不能含空格和 # 号。\n" +
    "- category：只能从 提示词 / 工具 / 教程 / 资讯 / 观点 / 其他 里选且只选 1 个。\n\n" +
    "正文：\n{{content}}",
  aiMaxChars: 6000,
  customRules: "",
  openAfterSave: true,
  tagsToDoc: true,
  /* 数据库落点（默认开：剪藏就该是一行 + 一篇文档） */
  saveToDb: true,
  dbAvId: "",
  dbBlockId: "",
  dbName: "",
  /* 文档放在哪：filetree = 文件树可见 + 绑定成行；dbonly = 只进表格（跟顺手一样） */
  docMode: "filetree",
  /* 保存后刷新界面（默认关：思源不会自动重绘已打开的表，刷新交给你） */
  refreshAfterSave: false,
  /* 图片 */
  localizeImages: false,
};

const AI_SYSTEM =
  "你是中文笔记编辑。只输出一个 JSON 对象，不要输出解释、不要用代码块包裹。字段：" +
  "title(字符串)、summary(字符串数组, 3 条)、tags(字符串数组, 3-5 个)、category(字符串)。";

/* ------------------------------------------------------------ 内置站点规则 */
const BUILTIN_RULES = [
  {
    id: "x",
    hosts: ["x.com", "twitter.com"],
    kind: "meta",
    title: ["og:title"],
    body: ["og:description"],
    author: ["twitter:creator", "og:title"],
    date: ["article:published_time"],
    note: "X 登录墙外的公开页只有 meta，正文即 og:description（长推文可能被截断）",
  },
  {
    id: "wechat",
    hosts: ["mp.weixin.qq.com"],
    kind: "selector",
    title: ["#activity-name"],
    body: ["#js_content"],
    author: ["#js_name", "meta[name=author]"],
    date: ["#publish_time", "meta[property='article:published_time']"],
  },
  {
    id: "github",
    hosts: ["github.com"],
    kind: "selector",
    title: ["article h1", ".markdown-body h1", "h1"],
    body: ["article.markdown-body", ".markdown-body"],
    author: ["[rel=author]", "meta[name=author]"],
    date: ["relative-time", "meta[property='article:published_time']"],
  },
  {
    id: "bilibili",
    hosts: ["bilibili.com"],
    kind: "selector",
    title: ["h1.video-title", ".article-title", "h1"],
    body: ["#read-article-holder", ".article-content", ".opus-module-content"],
    author: [".up-name", ".opus-module-author__name"],
    date: [".publish-text", "meta[property='article:published_time']"],
  },
  {
    id: "sspai",
    hosts: ["sspai.com"],
    kind: "selector",
    title: ["h1"],
    body: [".content", ".article__content", "#article-content"],
    author: [".article_author", ".author"],
    date: [".time", "meta[property='article:published_time']"],
  },
  {
    id: "juejin",
    hosts: ["juejin.cn"],
    kind: "selector",
    title: ["h1", ".article-title"],
    body: ["#article-root", ".article-content", ".markdown-body"],
    author: [".author-name", ".username"],
    date: [".time", "meta[property='article:published_time']"],
  },
  {
    id: "zhihu",
    hosts: ["zhihu.com"],
    kind: "selector",
    title: ["h1.Post-Title", ".QuestionHeader-title", "h1"],
    body: [".Post-RichText", ".RichText", ".AnswerItem .RichText"],
    author: [".AuthorInfo-name", ".UserLink-link"],
    date: [".ContentItem-time"],
    note: "知乎有反爬，通常拿不到正文，失败属正常",
  },
  {
    id: "douban",
    hosts: ["douban.com"],
    kind: "selector",
    title: ["h1 span[property=name]", "h1"],
    body: ["#link-report", ".indent", ".article"],
    author: [".author .name", "span[property=v:pname]"],
    date: ["meta[property='article:published_time']"],
  },
];

const NOISE_RE =
  /(^|[\s_-])(share|social|comment|comments|related|recommend|recommended|sidebar|side-bar|footer|header|nav|navbar|breadcrumb|advert|ads?|promo|banner|copyright|toolbar|qrcode|pagination|pager|subscribe|newsletter|login|signin|modal|popup|cookie)([\s_-]|$)/i;

/* ------------------------------------------------------------------ 工具 */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* 站点 → 好认的平台名（跟顺手一致：写 X 而不是 x.com） */
const PLATFORM_MAP = [
  [/^(x|twitter)\.com$/, "X"],
  [/^(mp\.)?weixin\.qq\.com$/, "微信"],
  [/^github\.com$/, "GitHub"],
  [/bilibili\.com$/, "B站"],
  [/douban\.com$/, "豆瓣"],
  [/juejin\.cn$/, "掘金"],
  [/sspai\.com$/, "少数派"],
  [/zhihu\.com$/, "知乎"],
  [/youtube\.com$/, "YouTube"],
  [/xiaohongshu\.com$/, "小红书"],
  [/^weibo\.(com|cn)$/, "微博"],
];

function platformOf(host) {
  const h = String(host || "").toLowerCase();
  for (const [re, name] of PLATFORM_MAP) if (re.test(h)) return name;
  return h;
}

function api(url, data) {
  return new Promise((resolve, reject) => {
    fetchPost(url, data, (res) => {
      if (res && res.code === 0) resolve(res.data);
      else reject(new Error((res && res.msg) || "内核接口调用失败：" + url));
    });
  });
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cleanTitle(t) {
  return String(t || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function renderPath(tpl, vars) {
  let out = String(tpl || "/Clippings/{{title}}");
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(cleanTitle(v));
  out = out.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!out.startsWith("/")) out = "/" + out;
  return out || "/Clippings/未命名";
}

/* ------------------------------------------------------- HTML → Markdown */
function textOf(node) {
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

function htmlToMarkdown(root) {
  if (!root) return "";
  const out = [];

  const inlineMd = (node) => {
    const buf = [];
    Array.from(node.childNodes).forEach((c) => {
      if (c.nodeType === 3) buf.push(c.nodeValue.replace(/\s+/g, " "));
      else if (c.nodeType === 1) {
        const t = c.tagName.toLowerCase();
        if (t === "a") {
          const href = c.getAttribute("href");
          const s = textOf(c);
          buf.push(href && s && !/^javascript:/i.test(href) ? `[${s}](${href})` : s);
        } else if (t === "img") {
          const src = c.getAttribute("src") || c.getAttribute("data-src");
          if (src) buf.push(` ![${esc(c.getAttribute("alt") || "")}](${src}) `);
        } else if (t === "strong" || t === "b") buf.push(`**${textOf(c)}**`);
        else if (t === "em" || t === "i") buf.push(`*${textOf(c)}*`);
        else if (t === "code") buf.push("`" + c.textContent + "`");
        else if (t === "br") buf.push("  \n");
        else {
          const s = inlineMd(c);
          if (s) buf.push(s);
        }
      }
    });
    return buf.join("").replace(/ {2,}/g, " ").trim();
  };

  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = node.nodeValue.replace(/[\r\n\t]+/g, " ");
      if (t.trim()) out.push(t.replace(/\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();
    const cn = typeof node.className === "string" ? node.className : "";
    if ((cn && NOISE_RE.test(cn)) || (node.id && NOISE_RE.test(node.id))) return;
    if (["script", "style", "noscript", "iframe", "svg", "canvas", "form", "input", "button", "select", "textarea"].includes(tag)) return;

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const t = textOf(node);
        if (t) out.push(`\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n`);
        return;
      }
      case "p": {
        const t = inlineMd(node);
        if (t) out.push(`\n\n${t}\n\n`);
        return;
      }
      case "br":
        out.push("  \n");
        return;
      case "hr":
        out.push("\n\n---\n\n");
        return;
      case "blockquote": {
        const inner = htmlToMarkdown(node).trim();
        if (inner) out.push("\n\n" + inner.split("\n").map((l) => "> " + l).join("\n") + "\n\n");
        return;
      }
      case "pre": {
        const code = node.textContent.replace(/\n+$/, "");
        if (code.trim()) out.push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
        return;
      }
      case "ul":
      case "ol": {
        const ordered = tag === "ol";
        const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === "li");
        if (!items.length) return;
        out.push("\n\n");
        items.forEach((li, i) => {
          const t = inlineMd(li).replace(/\s+/g, " ").trim();
          if (t) out.push(`${ordered ? `${i + 1}.` : "-"} ${t}\n`);
        });
        out.push("\n");
        return;
      }
      case "img": {
        const src = node.getAttribute("src") || node.getAttribute("data-src") || node.getAttribute("data-original");
        if (src) out.push(`\n\n![${esc(node.getAttribute("alt") || "")}](${src})\n\n`);
        return;
      }
      case "figure": {
        const img = node.querySelector("img");
        const cap = node.querySelector("figcaption");
        const src = img && (img.getAttribute("src") || img.getAttribute("data-src"));
        if (src) out.push(`\n\n![${esc((cap && textOf(cap)) || "")}](${src})\n\n`);
        else if (cap) out.push(`\n\n${textOf(cap)}\n\n`);
        return;
      }
      case "table": {
        const rows = Array.from(node.querySelectorAll("tr"));
        if (!rows.length) return;
        const cells = rows.map((r) => Array.from(r.children).map((c) => textOf(c).replace(/\|/g, "/")));
        const width = Math.max(...cells.map((r) => r.length));
        out.push("\n\n");
        cells.forEach((r, i) => {
          out.push("| " + r.concat(Array(width - r.length).fill("")).join(" | ") + " |\n");
          if (i === 0) out.push("|" + Array(width).fill(" --- ").join("|") + "|\n");
        });
        out.push("\n");
        return;
      }
      case "a": {
        const href = node.getAttribute("href");
        const t = textOf(node);
        if (href && t && !/^javascript:/i.test(href)) out.push(`[${t}](${href})`);
        else if (t) out.push(t);
        return;
      }
      case "strong":
      case "b": {
        const t = textOf(node);
        if (t) out.push(`**${t}**`);
        return;
      }
      case "em":
      case "i": {
        const t = textOf(node);
        if (t) out.push(`*${t}*`);
        return;
      }
      case "code": {
        const t = node.textContent;
        if (t.trim()) out.push("`" + t.replace(/`/g, "'") + "`");
        return;
      }
      default:
        Array.from(node.childNodes).forEach(walk);
    }
  };

  Array.from(root.childNodes).forEach(walk);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[ \t]+$/gm, "")
    .trim();
}

/* --------------------------------------------------------- 通用正文引擎 */
const CANDIDATES = [
  "article",
  "[role=main]",
  "main",
  ".markdown-body",
  ".post-content",
  ".article-content",
  ".article__content",
  ".rich_media_content",
  "#js_content",
  "#content",
  ".content",
  "body",
];

function pickMain(doc) {
  doc.querySelectorAll("script,style,noscript,iframe,nav,footer,header,aside,form").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    const cn = el.getAttribute("class") || "";
    const id = el.getAttribute("id") || "";
    if ((cn && NOISE_RE.test(cn)) || (id && NOISE_RE.test(id))) el.remove();
  });

  let best = null;
  let bestScore = 0;
  for (const sel of CANDIDATES) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const text = textOf(el);
      if (text.length < 120) continue;
      const linkText = Array.from(el.querySelectorAll("a")).map(textOf).join("").length;
      const pCount = el.querySelectorAll("p").length;
      const score = text.length - 1.4 * linkText + pCount * 30;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
  }
  return best || doc.body;
}

/* --------------------------------------------------------------- 抽取层 */
function metaOf(doc, names) {
  for (const n of names || []) {
    if (!n) continue;
    const el = n.startsWith("meta[") ? doc.querySelector(n) : doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    if (el) {
      const v = el.getAttribute("content") || "";
      if (v.trim()) return v.trim();
    }
  }
  return "";
}

function pickOne(doc, names) {
  for (const sel of names || []) {
    if (!sel) continue;
    let el = null;
    try {
      el = doc.querySelector(sel);
    } catch {
      el = null;
    }
    if (el) {
      const v = el.getAttribute && el.getAttribute("content");
      const t = (v || textOf(el) || "").trim();
      if (t) return t;
    }
  }
  return "";
}

function ruleFor(url, rules) {
  const host = hostOf(url);
  for (const r of rules) {
    if ((r.hosts || []).some((h) => host === h || host.endsWith("." + h))) return r;
  }
  return null;
}

function extract(html, url, rules) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rule = ruleFor(url, rules);
  const metaTitle = metaOf(doc, ["og:title"]) || (doc.querySelector("title") ? doc.querySelector("title").textContent : "") || "";
  const metaAuthor = metaOf(doc, ["author", "article:author", "twitter:creator"]) || metaOf(doc, ["og:site_name"]);
  const metaDate = metaOf(doc, ["article:published_time", "og:updated_time", "datePublished"]) || "";

  let title = "";
  let body = "";
  let author = "";
  let date = "";
  let usedRule = "generic";
  let metaBody = false;

  if (rule && rule.kind === "meta") {
    usedRule = rule.id;
    title = metaOf(doc, rule.title) || metaTitle;
    body = metaOf(doc, rule.body);
    author = metaOf(doc, rule.author) || metaAuthor;
    date = metaOf(doc, rule.date) || metaDate;
    const m = /^(.*?)\s*\(@([^)]+)\)/.exec(title);
    if (m) {
      // 中文页面的 og:title 形如「X 上的 Gk (@0xGky)」，英文是「Gk (@0xGky) on X」
      const name = m[1]
        .replace(/^X\s*上的\s*/, "")
        .replace(/\s*on\s+X$/i, "")
        .trim();
      author = `${name} @${m[2]}`;
    }
    body = body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .join("\n\n");
    if (body.length >= 20) metaBody = true;
  } else if (rule && rule.kind === "selector") {
    const t = pickOne(doc, rule.title);
    const b = pickOne(doc, rule.body);
    if (b && b.length > 60) {
      usedRule = rule.id;
      title = t || metaTitle;
      author = pickOne(doc, rule.author) || metaAuthor;
      date = pickOne(doc, rule.date) || metaDate;
      const el = (rule.body || []).map((s) => doc.querySelector(s)).find(Boolean);
      const box = doc.createElement("div");
      if (el) box.appendChild(el.cloneNode(true));
      body = htmlToMarkdown(box);
    }
  }

  if (!metaBody && (!body || body.length < 60)) {
    const genericBody = htmlToMarkdown(pickMain(doc));
    if (genericBody && genericBody.length > (body || "").length + 40) {
      usedRule = usedRule === "generic" ? "generic" : usedRule + "+generic";
      body = genericBody;
    } else if (!body) {
      body = genericBody || "";
    }
    if (!title) title = metaTitle;
    if (!author) author = metaAuthor;
    if (!date) date = metaDate;
  }

  if (body && body.length < 40) {
    const desc = metaOf(doc, ["og:description", "description"]);
    if (desc) body = desc;
  }

  if (date) {
    const d = String(date).trim();
    const iso = /^\d{4}-\d{2}-\d{2}/.exec(d);
    date = iso ? iso[0] : d.slice(0, 32);
  }

  const host0 = hostOf(url);
  if ((host0 === "x.com" || host0 === "twitter.com") && /\(@[^)]+\)/.test(title) && body) {
    const name = title.split("(@")[0].replace(/^X\s*上的\s*/, "").trim();
    const lead = (body.split(/\n+/)[0] || "").trim().slice(0, 40);
    if (name && lead) title = `${name}：${lead}`;
  }

  if (title && body) {
    const firstLine = body.split("\n").find((l) => l.trim());
    if (firstLine && firstLine.replace(/^#+\s*/, "").trim() === title.trim()) {
      body = body.slice(body.indexOf(firstLine) + firstLine.length).trim();
    }
  }

  return {
    title: cleanTitle(title || host0 || url),
    body: body.trim(),
    author: author.trim(),
    date: date.trim(),
    url,
    host: host0,
    rule: usedRule,
    chars: body.trim().length,
  };
}

/* --------------------------------------------------------------- AI 层 */
async function fetchPage(url) {
  const res = await api("/api/network/forwardProxy", {
    url,
    method: "GET",
    timeout: 30000,
    contentType: "",
    headers: [
      {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    ],
    payload: "",
    payloadEncoding: "text",
    responseEncoding: "text",
  });
  if (!res || !res.body) throw new Error("抓取失败：没有返回内容");
  if (res.status >= 400) throw new Error(`抓取失败：HTTP ${res.status}`);
  return res.body;
}

async function proxyJSON(url, bodyObj, apiKey) {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) h.Authorization = "Bearer " + apiKey;
  const headers = [h];
  const res = await api("/api/network/forwardProxy", {
    url,
    method: "POST",
    timeout: 90000,
    contentType: "application/json",
    headers,
    payload: bodyObj,
    responseEncoding: "text",
  });
  const text = (res && res.body) || "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: (res && res.status) || 0, text, json };
}

function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ------------------------------------------------ 思源内置 AI（不走 Key） */
function siyuanAIConf() {
  try {
    const c = window.siyuan && window.siyuan.config;
    return (c && c.ai) || null;
  } catch {
    return null;
  }
}

function siyuanProviders() {
  const ai = siyuanAIConf();
  const list = (ai && ai.providers) || [];
  return list
    .filter((p) => p && p.enabled !== false)
    .map((p) => ({ id: p.id, name: p.displayName || p.id, baseURL: p.baseURL || "", models: (p.models || []).map((m) => m.name) }));
}

async function siyuanListModels(providerId) {
  const data = await api("/api/ai/listModels", { provider: providerId });
  return (data && data.models) || [];
}

async function siyuanChat(providerId, model, msg) {
  const data = await api("/api/ai/chatGPT", { provider: providerId, model, msg });
  return String(data || "");
}

/* 自定义接口：拉模型列表（{baseURL}/models） */
async function remoteListModels(baseURL, apiKey) {
  const base = String(baseURL || "").replace(/\/+$/, "");
  if (!base) throw new Error("先填基础 URL");
  const h = { Accept: "application/json" };
  if (apiKey) h.Authorization = "Bearer " + apiKey;
  const res = await api("/api/network/forwardProxy", {
    url: base + "/models",
    method: "GET",
    timeout: 30000,
    contentType: "",
    headers: [h],
    payload: "",
    payloadEncoding: "text",
    responseEncoding: "text",
  });
  if (!res || res.status < 200 || res.status >= 300) {
    throw new Error("HTTP " + ((res && res.status) || 0) + "（地址/Key 可能不对）");
  }
  let j = null;
  try {
    j = JSON.parse(res.body);
  } catch {
    throw new Error("返回的不是 JSON");
  }
  const arr = Array.isArray(j) ? j : j.data || j.models || [];
  return arr
    .map((m) => (typeof m === "string" ? m : m.id || m.name || ""))
    .filter(Boolean)
    .sort();
}

async function runAI(settings, doc) {
  const s = settings;
  if (!s.useAI) return null;
  const mode = s.ai.mode || "siyuan";
  if (!s.ai.model) throw new Error(mode === "siyuan" ? "还没选模型：设置 → 模型来源选思源内置" : "还没配置 AI：模型是必填");
  if (mode === "custom" && !s.ai.baseURL) throw new Error("还没配置 AI：基础 URL 是必填");

  const content = doc.body.slice(0, Number(s.aiMaxChars) || 6000);
  const user = String(s.promptTemplate).split("{{content}}").join(content);

  let contentText = "";
  if (mode === "siyuan") {
    // 思源自己带着 key 去请求，插件不接触密钥
    contentText = await siyuanChat(s.ai.provider, s.ai.model, AI_SYSTEM + "\n\n" + user);
  } else {
    const base = String(s.ai.baseURL).replace(/\/+$/, "");
    const body = {
      model: s.ai.model,
      temperature: 0.3,
      messages: [
        { role: "system", content: AI_SYSTEM },
        { role: "user", content: user },
      ],
    };
    let r = await proxyJSON(base + "/chat/completions", { ...body, response_format: { type: "json_object" } }, s.ai.apiKey);
    if (r.status === 400 || r.status === 422 || r.status === 404) {
      r = await proxyJSON(base + "/chat/completions", body, s.ai.apiKey);
    }
    if (r.status < 200 || r.status >= 300) {
      const msg = (r.json && (r.json.error?.message || r.json.message)) || r.text.slice(0, 200);
      throw new Error(`模型接口 HTTP ${r.status}：${msg}`);
    }
    contentText =
      (r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) || "";
  }

  const parsed = extractJson(typeof contentText === "string" ? contentText : JSON.stringify(contentText));
  if (!parsed) throw new Error("模型没有返回可解析的 JSON");

  // 模型偶尔不用逗号、而用空格把多个标签串成一个（"HTML PPT PPT 模板 网页"）：
  // 三个以上空格分隔的碎片就拆成多个标签，"PPT 模板" 这种两个词的保留为一个。
  const rawTags = [];
  for (const t of Array.isArray(parsed.tags) ? parsed.tags : []) {
    const s = String(t || "").trim();
    if (!s) continue;
    const chunks = s.split(/[\s\u3000]+/).filter(Boolean);
    if (chunks.length >= 3) rawTags.push(...chunks);
    else rawTags.push(s);
  }

  return {
    title: cleanTitle(parsed.title || ""),
    summary: Array.isArray(parsed.summary) ? parsed.summary.filter(Boolean).slice(0, 5) : [],
    tags: rawTags
      .map((t) =>
        String(t)
          .trim()
          .replace(/^#/, "")
          .replace(/[\s\u3000]+/g, "_")
          .replace(/[^\w\u4e00-\u9fa5\-]/g, "")
          .toLowerCase()
      )
      .filter((t) => t && t !== "_")
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .slice(0, 6),
    category: String(parsed.category || "").trim(),
  };
}

/* ------------------------------------------------------- 思源侧：数据库 */
async function listDatabases() {
  const data = await api("/api/av/searchAttributeView", { keyword: "", excludes: [] });
  const results = (data && data.results) || [];
  return results.map((r) => ({
    avId: r.avID,
    blockId: r.blockID,
    name: r.avName || "(未命名)",
    hPath: r.hPath || "",
  }));
}

async function dbColumns(avId) {
  const data = await api("/api/av/getAttributeView", { id: avId });
  const av = data && data.av;
  if (!av) throw new Error("找不到数据库：" + avId);
  return ((av.keyValues || []).map((k) => ({ id: k.key.id, name: k.key.name, type: k.key.type })));
}

function cellValue(type, raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  switch (type) {
    case "text":
      return { text: { content: s } };
    case "url":
      return { url: { content: s } };
    case "date": {
      const t = Date.parse(s.length === 10 ? s + "T00:00:00" : s);
      if (!Number.isFinite(t)) return null;
      return { date: { content: t, isNotEmpty: true, isNotTime: s.length === 10 } };
    }
    case "mSelect":
    case "select": {
      let parts = s.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean);
      // 模型偶尔不用逗号、用空格分隔（“HTML PPT PPT 模板 网页”），这时按空白再拆一次
      if (parts.length === 1 && /\s/.test(parts[0])) {
        const bySpace = parts[0].split(/\s+/).filter(Boolean);
        if (bySpace.length > 1) parts = bySpace;
      }
      return parts.length ? { mSelect: parts.map((content) => ({ content })) } : null;
    }
    case "number": {
      const n = Number(s.replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? { number: { content: n, isNotEmpty: true } } : null;
    }
    case "checkbox":
      return { checkbox: { checked: !["", "0", "false", "no", "否"].includes(s.toLowerCase()) } };
    default:
      return { text: { content: s } };
  }
}

/* 列名 → 取值（列不存在就跳过，所以换库也能用） */
function buildCells(columns, itemId, doc, ai) {
  const values = [];
  for (const col of columns) {
    let raw = null;
    const n = String(col.name || "").trim();
    if (n === "链接" || n === "网址" || n === "URL" || n === "url") raw = doc.url;
    else if (n === "作者" || n === "author") raw = doc.author;
    else if (n === "日期" || n === "date") raw = doc.date;
    else if (n === "分类" || n === "category") raw = ai && ai.category;
    else if (n === "标签" || n === "tags") raw = ai && ai.tags && ai.tags.length ? ai.tags.join(",") : null;
    else if (n === "来源" || n === "source") raw = platformOf(doc.host);
    else if (n === "摘要" || n === "summary") raw = ai && ai.summary ? ai.summary.join(" / ") : null;
    if (!raw) continue;
    const v = cellValue(col.type, raw);
    if (v) values.push({ itemID: itemId, keyID: col.id, value: v });
  }
  return values;
}

/* ------------------------------------------------------- 思源侧：图片 */
function siyuanToken() {
  try {
    return (window.siyuan && window.siyuan.config && window.siyuan.config.api && window.siyuan.config.api.token) || "";
  } catch {
    return "";
  }
}

async function uploadAsset(src) {
  const res = await api("/api/network/forwardProxy", {
    url: src,
    method: "GET",
    timeout: 30000,
    contentType: "",
    headers: [{ "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*" }],
    payload: "",
    payloadEncoding: "text",
    responseEncoding: "base64",
  });
  if (!res || !res.body) throw new Error("下载失败");
  const bin = atob(res.body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const bare = src.split("?")[0].split("#")[0];
  let name = bare.split("/").pop() || "image";
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const ct = String((res && res.contentType) || "");
    const ext = /image\/(\w+)/.exec(ct);
    name += "." + (ext ? ext[1].replace("jpeg", "jpg") : "png");
  }
  name = name.replace(/[^\w.\-]/g, "_").slice(-60) || "image.png";

  const fd = new FormData();
  fd.append("assetsDirPath", "/assets/");
  fd.append("file[]", new Blob([bytes]), name);

  const token = siyuanToken();
  const headers = token ? { Authorization: "Token " + token } : {};
  const r = await fetch("/api/asset/upload", { method: "POST", body: fd, headers });
  const j = await r.json();
  if (!j || j.code !== 0) throw new Error((j && j.msg) || "上传失败");
  const succ = (j.data && j.data.succMap) || {};
  const first = Object.keys(succ)[0];
  return first ? succ[first] : "";
}

async function localizeImages(markdown, limit = 30) {
  const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const seen = new Map();
  const urls = [];
  let m;
  while ((m = re.exec(markdown))) {
    const u = m[2];
    if (!seen.has(u) && urls.length < limit) {
      seen.set(u, "");
      urls.push(u);
    }
  }
  let done = 0;
  let failed = 0;
  for (const u of urls) {
    try {
      const local = await uploadAsset(u);
      if (local) {
        seen.set(u, local);
        done++;
      } else failed++;
    } catch {
      failed++;
    }
  }
  let out = markdown.replace(re, (whole, alt, u) => {
    const local = seen.get(u);
    return local ? `![${alt}](${local})` : whole;
  });
  return { markdown: out, done, failed, total: urls.length };
}

/* --------------------------------------------------------------- 主插件 */
class ClipPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addIcons(ICON_SYMBOL);
    // 记住最近的鼠标动作，用来判断 dock 展开是用户点的还是启动时恢复的
    this._lastPointer = 0;
    this._onPointer = () => {
      this._lastPointer = Date.now();
    };
    window.addEventListener("pointerdown", this._onPointer, true);

    // 左侧竖排栏（新签名：config + type + init 缺一不可）
    this.addDock({
      config: {
        position: "LeftTop",
        size: { width: 320, height: 0 },
        icon: "iconClipIn",
        title: "剪藏链接",
        hotkey: "",
      },
      data: { text: "剪藏链接" },
      type: "sy-clip-dock",
      resize() {},
      update() {},
      init: (dock) => {
        if (!dock || !dock.element) return;
        dock.element.innerHTML =
          '<div class="sy-clip-dock">' +
          '<div class="sy-clip-dock-title">剪藏链接</div>' +
          '<div class="sy-clip-dock-hint">粘贴网址 → 抓取解析 → 保存到思源<br>快捷键 Alt + Shift + K</div>' +
          '<button class="b3-button b3-button--outline" id="sy-clip-dock-open">打开剪藏面板</button>' +
          "</div>";
        const btn = dock.element.querySelector("#sy-clip-dock-open");
        if (btn) btn.addEventListener("click", () => this.openClipper());

        // 用户点图标展开的，就直接弹窗，不再让他多点一下
        if (Date.now() - (this._lastPointer || 0) < 1200) {
          setTimeout(() => this.openClipper(), 80);
        }
      },
    });
    this.addCommand({
      langKey: "openClipper",
      hotkey: "Alt+Shift+K",
      callback: () => this.openClipper(),
    });
  }

  onunload() {
    if (this._onPointer) window.removeEventListener("pointerdown", this._onPointer, true);
  }

  async loadSettings() {
    const saved = (await this.loadData("settings.json")) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.settings.ai = Object.assign({}, DEFAULT_SETTINGS.ai, saved.ai || {});
    // 老配置迁移：以前只有自定义接口，没 mode 字段
    if (!this.settings.ai.mode) this.settings.ai.mode = this.settings.ai.baseURL ? "custom" : "siyuan";
    // 老默认路径带 {{date}} 子目录，统一拍平，跟用户原有结构一致
    if (this.settings.pathTemplate === "/Clippings/{{date}}/{{title}}") {
      this.settings.pathTemplate = "/Clippings/{{title}}";
    }
  }

  async saveSettings() {
    await this.saveData("settings.json", this.settings);
  }

  allRules() {
    let custom = [];
    if (this.settings.customRules && this.settings.customRules.trim()) {
      try {
        const parsed = JSON.parse(this.settings.customRules);
        if (Array.isArray(parsed)) custom = parsed;
      } catch {
        showMessage("自定义规则 JSON 解析失败，已忽略", 4000, "error");
      }
    }
    const map = new Map(BUILTIN_RULES.map((r) => [r.id, r]));
    for (const r of custom) if (r && r.id) map.set(r.id, r);
    return Array.from(map.values());
  }

  /* ------------------------------------------------------- 解析单条 */
  async parseOne(url) {
    const html = await fetchPage(url);
    const doc = extract(html, url, this.allRules());
    if (!doc.body) throw new Error("没抓到正文（可能需要登录，或这个站点用 JS 渲染）");
    let ai = null;
    let aiError = "";
    if (this.settings.useAI) {
      try {
        ai = await runAI(this.settings, doc);
        if (ai && ai.title) doc.title = ai.title;
      } catch (e) {
        aiError = e.message;
      }
    }
    return { url, doc, ai, aiError, saved: false, path: "", error: "" };
  }

  /* ------------------------------------------------------- 保存单条 */
  async saveOne(item) {
    const s = this.settings;
    if (!s.notebook) throw new Error("还没选笔记本：先打开设置选一个");
    const { doc, ai } = item;

    let body = doc.body;
    let imgInfo = null;
    if (s.localizeImages) {
      try {
        imgInfo = await localizeImages(body);
        body = imgInfo.markdown;
      } catch (e) {
        imgInfo = { done: 0, failed: 1, total: 1, error: e.message };
      }
    }

    const parts = [];
    if (ai && ai.summary && ai.summary.length) {
      parts.push("## AI 摘要\n\n" + ai.summary.map((x) => "- " + String(x).trim()).join("\n"));
    }
    if (ai && ai.tags && ai.tags.length) parts.push("标签：" + ai.tags.map((t) => `\`${t}\``).join(" "));
    if (doc.rule === "x") parts.push("> X 的公开页只给出摘要级的正文，长推文可能被截断；完整内容请看文末原链接。");
    parts.push("## 正文\n\n" + body);
    parts.push(
      "---\n\n来源：[原始链接](" + doc.url + ")" + (doc.author ? " · " + doc.author : "") + (doc.date ? " · " + doc.date : "")
    );

    const path = renderPath(s.pathTemplate, {
      title: doc.title,
      date: today(),
      year: String(new Date().getFullYear()),
      hostname: doc.host,
      author: doc.author,
      category: (ai && ai.category) || "",
    });

    /*
     * 安全约定：本插件只做「新建」和「写属性」，永不调用：
     *   removeDoc / removeDocByID / removeDocs / moveDocs / moveDocsByID / renameDoc
     * 上面这几个都不在代码里，以后也别加。
     * 写入前把要做什么打出来，出问题时能回溯。
     */
    console.log("[sy-clip] 即将写入", {
      notebook: s.notebook,
      path,
      chars: body.length,
      images: imgInfo ? { done: imgInfo.done, failed: imgInfo.failed } : null,
      db: s.saveToDb ? { avId: s.dbAvId, blockId: s.dbBlockId } : null,
    });

    const markdown = parts.join("\n\n");
    const useDbOnly = s.saveToDb && s.docMode === "dbonly" && s.dbAvId && s.dbBlockId;

    let docId = "";
    let itemId = "";
    let fallbackPath = path;

    if (useDbOnly) {
      // 「只进表格」需要思源数据库里有一个「文档型条目模板」，否则内核直接报 templateID required
      const detail = await api("/api/av/getAttributeView", { id: s.dbAvId });
      const av = (detail && detail.av) || {};
      const tpls = (av.newItemTemplates || []).filter((t) => (t.targetType || "document") === "document");
      const tpl = tpls.find((t) => t.id === av.defaultTemplateID) || tpls[0];
      if (!tpl) {
        const det = (av.newItemTemplates || []).some((t) => t.targetType === "detached");
        throw new Error(
          "这个数据库没有「文档型条目模板」，思源不允许只往表里加行。" +
            (det ? "（现在只有一个『无文档』模板，用它建的行没有正文。）" : "") +
            "解法：在思源里打开数据库 → 右上角 ⋯ → 新建模板 → 目标类型选「文档条目」→ 勾上「不在文档树中显示」→ 保存；建好后再剪。或者把「文档放在哪」改成「文件树里可见」。"
        );
      }
      // 跟顺手一样：文档作为数据库条目存在，文件树里不建文件
      const created = await api("/api/av/createAttributeViewItemWithMarkdown", {
        avID: s.dbAvId,
        blockID: s.dbBlockId,
        templateID: tpl.id,
        title: doc.title,
        markdown,
        ...(s.tagsToDoc && ai && ai.tags && ai.tags.length ? { tags: ai.tags.join(",") } : {}),
      });
      itemId = (created && created.itemID) || "";
      docId = (created && created.blockID) || itemId;
      fallbackPath = "（只在表格里，文件树不建文件）";
    } else {
      docId = await api("/api/filetree/createDocWithMd", { notebook: s.notebook, path, markdown });
      if (s.tagsToDoc && ai && ai.tags && ai.tags.length && docId) {
        try {
          await api("/api/attr/setBlockAttrs", { id: docId, attrs: { tags: ai.tags.join(",") } });
        } catch {
          /* 标签失败不影响主体 */
        }
      }
    }

    let dbNote = "";
    let dbWritten = false;
    if (s.saveToDb && !(s.dbAvId && s.dbBlockId)) {
      dbNote = "没选数据库，只存了文档（设置里选一个库就会自动落行）";
    } else if (s.saveToDb) {
      try {
        if (!useDbOnly) {
          await api("/api/av/addAttributeViewBlocks", {
            avID: s.dbAvId,
            blockID: s.dbBlockId,
            srcs: [{ itemID: docId, id: docId, isDetached: false, content: doc.title }],
          });
          itemId = docId;
        }
        const columns = await dbColumns(s.dbAvId);
        const values = buildCells(columns, itemId || docId, doc, ai);
        if (values.length) {
          await api("/api/av/batchSetAttributeViewBlockAttrs", { avID: s.dbAvId, values });
        }
        dbNote = "已写入数据库";
        dbWritten = true;
      } catch (e) {
        dbNote = "数据库写入失败：" + e.message;
      }
    }

    item.saved = true;
    item.path = fallbackPath;
    item.docId = docId;
    return { path: fallbackPath, docId, imgInfo, dbNote, dbWritten };
  }

  /* ------------------------------------------------------------ 主界面 */
  async openClipper(prefill) {
    const content = `
<div class="ci-wrap">
  <div class="ci-field">
    <label>链接（一行一个，可批量）</label>
    <textarea id="ciUrls" class="b3-text-field fn__block" rows="4" placeholder="https://…">${esc(prefill || "")}</textarea>
  </div>
  <div class="ci-row">
    <button id="ciFetch" class="b3-button b3-button--outline">抓取解析</button>
    <button id="ciSettings" class="b3-button b3-button--text">设置</button>
    <span class="tb-spacer fn__flex-1"></span>
    <button id="ciSaveAll" class="b3-button b3-button--outline fn__none">全部保存</button>
  </div>
  <div id="ciStatus" class="ci-status">通用网页 + 内置站点规则（X / 公众号 / GitHub / B站 / 掘金 / 知乎 / 豆瓣 / 少数派）</div>
  <div id="ciList" class="ci-list"></div>
</div>`;

    const dialog = new Dialog({
      title: "剪藏链接",
      content: `<div class="b3-dialog__content">${content}</div>`,
      width: "860px",
      height: "80vh",
    });

    const el = dialog.element;
    const $ = (sel) => el.querySelector(sel);
    const urlsBox = $("#ciUrls");
    const status = $("#ciStatus");
    const list = $("#ciList");
    const saveAllBtn = $("#ciSaveAll");
    const queue = [];

    const setStatus = (t, kind) => {
      status.textContent = t;
      status.className = "ci-status" + (kind ? " ci-" + kind : "");
    };

    // 剪藏前先把「只存文档 / 也写数据库」说清楚，免得又以为没进表
    if (!this.settings.saveToDb) {
      setStatus("注意：写入数据库是关的，只会存文档（设置里可以打开）", "warn");
    } else if (!this.settings.dbAvId) {
      setStatus("注意：还没选数据库，只会存文档（设置 → 数据库 里选一个）", "warn");
    }

    const renderList = () => {
      list.innerHTML = queue
        .map((it, i) => {
          const title = (it.ai && it.ai.title) || (it.doc && it.doc.title) || it.url;
          const meta = it.doc
            ? [it.doc.host, it.doc.author, it.doc.date, `${it.doc.chars} 字`, `规则：${it.doc.rule}`].filter(Boolean).join(" · ")
            : "";
          const sum = it.ai && it.ai.summary ? it.ai.summary : [];
          const tags = it.ai && it.ai.tags ? it.ai.tags : [];
          const state = it.error
            ? `<span class="ci-state ci-error">失败</span>`
            : it.saved
            ? `<span class="ci-state ci-ok">已保存</span>`
            : `<button class="b3-button b3-button--mini" data-save="${i}">保存</button>`;
          return `
<div class="ci-card">
  <div class="ci-card-head">
    <span class="ci-title">${esc(title)}</span>
    ${state}
  </div>
  <div class="ci-meta">${esc(meta)}</div>
  ${it.error ? `<div class="ci-err">${esc(it.error)}</div>` : ""}
  ${it.aiError ? `<div class="ci-warn">AI 失败：${esc(it.aiError)}（已按原文保存）</div>` : ""}
  ${it.path ? `<div class="ci-meta">→ ${esc(it.path)}</div>` : ""}
  ${
    it.ai && it.ai.category
      ? `<div class="ci-badges"><span class="ci-badge">${esc(it.ai.category)}</span>${tags
          .map((t) => `<span class="ci-badge ci-badge--tag">${esc(t)}</span>`)
          .join("")}</div>`
      : ""
  }
  ${sum.length ? `<ul class="ci-sum">${sum.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
  ${it.doc && !it.error ? `<pre class="ci-body">${esc(it.doc.body.slice(0, 400))}${it.doc.body.length > 400 ? "…" : ""}</pre>` : ""}
</div>`;
        })
        .join("");
      list.querySelectorAll("[data-save]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const idx = Number(btn.getAttribute("data-save"));
          btn.disabled = true;
          btn.textContent = "保存中…";
          try {
            const r = await this.saveOne(queue[idx]);
            const note = [r.imgInfo ? `图片 ${r.imgInfo.done}/${r.imgInfo.total}` : "", r.dbNote].filter(Boolean).join("，");
            showMessage("已保存：" + r.path + (note ? "（" + note + "）" : ""), 3000);
            if (r.dbWritten && this.settings.refreshAfterSave) {
              setStatus("已写入表格，界面即将刷新…", "ok");
              setTimeout(() => window.location.reload(), 1200);
              return;
            }
            if (r.dbWritten) {
              const open = document.querySelector(`[data-node-id="${this.settings.dbBlockId}"]`);
              if (open) {
                setStatus("已写入表格。表格不会自己重绘：重开这篇文档（或按 F5）就能看到新行", "ok");
                showMessage("已写入表格；重开这篇文档即可看到新行", 4000);
                return;
              }
            }
            if (this.settings.openAfterSave && r.docId && queue.length === 1) {
              openTab({ app: this.app, doc: { id: r.docId, title: queue[idx].doc.title } });
              dialog.destroy();
              return;
            }
          } catch (e) {
            queue[idx].error = e.message;
          }
          renderList();
        });
      });
      saveAllBtn.classList.toggle("fn__none", !queue.some((q) => !q.saved && !q.error));
    };

    const doFetch = async () => {
      const urls = urlsBox.value
        .split(/\s+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x, i, arr) => arr.indexOf(x) === i);
      if (!urls.length) {
        setStatus("先贴一个链接", "error");
        return;
      }
      if (urls.length > 20) {
        setStatus("一次最多 20 条，已截断", "warn");
        urls.length = 20;
      }
      queue.length = 0;
      list.innerHTML = "";
      saveAllBtn.classList.add("fn__none");

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (!/^https?:\/\//i.test(url)) {
          queue.push({ url, doc: null, ai: null, error: "不是 http(s) 链接" });
          renderList();
          continue;
        }
        setStatus(`(${i + 1}/${urls.length}) 正在抓取 ${hostOf(url)}…`);
        try {
          const item = await this.parseOne(url);
          queue.push(item);
          renderList();
        } catch (e) {
          queue.push({ url, doc: null, ai: null, error: e.message });
          renderList();
        }
      }
      const ok = queue.filter((q) => !q.error).length;
      setStatus(`解析完成：成功 ${ok} 条，失败 ${queue.length - ok} 条`, ok ? "ok" : "error");
    };

    saveAllBtn.addEventListener("click", async () => {
      saveAllBtn.disabled = true;
      let anyDb = false;
      const pending = queue.map((q, i) => ({ q, i })).filter(({ q }) => !q.error && !q.saved);
      for (let n = 0; n < pending.length; n++) {
        const { q } = pending[n];
        setStatus(`(${n + 1}/${pending.length}) 正在写入 ${q.doc && q.doc.title}…`);
        try {
          const r = await this.saveOne(q);
          if (r && r.dbWritten) anyDb = true;
        } catch (e) {
          q.error = e.message;
        }
        renderList();
      }
      saveAllBtn.disabled = false;
      const saved = queue.filter((q) => q.saved).length;
      setStatus(`保存完成：${saved} 条已写入`, "ok");
      if (anyDb && this.settings.refreshAfterSave) {
        setStatus(`保存完成：${saved} 条已写入，界面即将刷新…`, "ok");
        setTimeout(() => window.location.reload(), 1400);
      }
    });

    $("#ciFetch").addEventListener("click", doFetch);
    $("#ciSettings").addEventListener("click", () => this.openSettings());
    urlsBox.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        doFetch();
      }
    });

    if (!prefill) {
      try {
        const txt = await navigator.clipboard.readText();
        if (txt && /^https?:\/\/\S+$/.test(txt.trim())) urlsBox.value = txt.trim();
      } catch {
        /* 读剪贴板失败就算了 */
      }
    }
    urlsBox.focus();
  }

  /* ------------------------------------------------------------ 设置界面 */
  async openSettings() {
    let notebooks = [];
    let databases = [];
    try {
      const data = await api("/api/notebook/lsNotebooks", {});
      notebooks = (data.notebooks || []).filter((n) => !n.closed);
    } catch (e) {
      showMessage("读取笔记本失败：" + e.message, 4000, "error");
    }
    try {
      databases = await listDatabases();
    } catch {
      databases = [];
    }

    const s = this.settings;
    const nbOptions = notebooks
      .map((n) => `<option value="${esc(n.id)}"${n.id === s.notebook ? " selected" : ""}>${esc(n.name)}</option>`)
      .join("");
    const dbOptions = databases
      .map(
        (d) =>
          `<option value="${esc(d.avId)}"${d.avId === s.dbAvId ? " selected" : ""}>${esc(d.name)}${
            d.hPath ? " · " + esc(d.hPath) : ""
          }</option>`
      )
      .join("");

    const content = `
<div class="ci-wrap">
  <div class="ci-field">
    <label>笔记本</label>
    <select id="setNotebook" class="b3-select">${nbOptions || `<option value="">（没有打开的笔记本）</option>`}</select>
  </div>
  <div class="ci-field">
    <label>保存路径模板</label>
    <input id="setPath" class="b3-text-field" value="${esc(s.pathTemplate)}">
    <div class="ci-hint">变量：{{title}} {{date}} {{year}} {{hostname}} {{author}} {{category}}；最后一段就是文档标题</div>
  </div>
  <div class="ci-field">
    <label>文档放在哪</label>
    <select id="setDocMode" class="b3-select">
      <option value="filetree"${s.docMode !== "dbonly" ? " selected" : ""}>文件树里可见 + 表格一行（推荐）</option>
      <option value="dbonly"${s.docMode === "dbonly" ? " selected" : ""}>只进表格，文件树里不建文件（跟顺手一样）</option>
    </select>
    <div class="ci-hint">选「只进表格」时路径模板不生效。思源要求库里有一个「文档型条目模板」，且要勾上「不在文档树中显示」，否则文档会出现在文件树里。</div>
  </div>

  <div class="ci-field ci-field--row">
    <label>启用 AI 整理</label>
    <input id="setUseAI" type="checkbox" class="b3-switch fn__flex-inline" ${s.useAI ? "checked" : ""}>
  </div>
  <div class="ci-field">
    <label>模型来源</label>
    <select id="setMode" class="b3-select">
      <option value="siyuan"${(s.ai.mode || "siyuan") === "siyuan" ? " selected" : ""}>思源内置 AI（不用填 Key，推荐）</option>
      <option value="custom"${s.ai.mode === "custom" ? " selected" : ""}>自定义 OpenAI 兼容接口</option>
    </select>
  </div>

  <div id="aiSiyuanBox" class="ci-box">
    <div class="ci-field">
      <label>提供方（来自 设置 → AI）</label>
      <select id="setProvider" class="b3-select"></select>
    </div>
    <div class="ci-field">
      <label>模型</label>
      <div class="ci-row">
        <select id="setSiYuanModel" class="b3-select fn__flex-1"></select>
        <button id="ciRefreshSy" class="b3-button b3-button--mini b3-button--outline">刷新</button>
        <button id="ciTestSy" class="b3-button b3-button--mini b3-button--outline">测试</button>
      </div>
      <div id="ciTestSyMsg" class="ci-hint"></div>
    </div>
  </div>

  <div id="aiCustomBox" class="ci-box fn__none">
    <div class="ci-field">
      <label>AI 基础 URL（OpenAI 兼容）</label>
      <input id="setBase" class="b3-text-field" placeholder="https://api.deepseek.com 或 https://xxx/v1" value="${esc(s.ai.baseURL)}">
      <div class="ci-hint">只填到版本号为止（如 <code>https://api.xxx.com/v1</code>），不要带 <code>/chat/completions</code></div>
    </div>
    <div class="ci-field">
      <label>AI API Key</label>
      <input id="setKey" type="password" class="b3-text-field" value="${esc(s.ai.apiKey)}">
    </div>
    <div class="ci-field">
      <label>模型</label>
      <div class="ci-row">
        <input id="setModelInput" class="b3-text-field fn__flex-1" list="ciModelList" placeholder="gemini-2.5-flash / deepseek-chat" value="${esc(s.ai.model)}">
        <datalist id="ciModelList"></datalist>
        <button id="ciRefreshCustom" class="b3-button b3-button--mini b3-button--outline">刷新</button>
        <button id="ciTestCustom" class="b3-button b3-button--mini b3-button--outline">测试</button>
      </div>
      <div id="ciTestCustomMsg" class="ci-hint"></div>
    </div>
  </div>
  <div class="ci-field">
    <label>提示词模板（{{content}} 处填正文）</label>
    <textarea id="setPrompt" class="b3-text-field fn__block" rows="7">${esc(s.promptTemplate)}</textarea>
  </div>
  <div class="ci-field">
    <label>喂给模型的正文字数上限</label>
    <input id="setMaxChars" type="number" class="b3-text-field" value="${Number(s.aiMaxChars) || 6000}">
  </div>

  <div class="ci-sep">写进数据库表格</div>
  <div class="ci-field ci-field--row">
    <label>同时在这张表里加一行</label>
    <input id="setUseDb" type="checkbox" class="b3-switch fn__flex-inline" ${s.saveToDb ? "checked" : ""}>
  </div>
  <div class="ci-field">
    <label>加到哪张表</label>
    <select id="setDb" class="b3-select">${dbOptions || `<option value="">（没有找到数据库）</option>`}</select>
    <div class="ci-hint">按列名自动对应：链接 / 作者 / 日期 / 分类 / 标签 / 来源 / 摘要（库里没有的列会跳过）。不开这个开关就只存文档。</div>
  </div>

  <div class="ci-sep">其它</div>
  <div class="ci-field ci-field--row">
    <label>图片下载到思源资源目录</label>
    <input id="setImg" type="checkbox" class="b3-switch fn__flex-inline" ${s.localizeImages ? "checked" : ""}>
  </div>
  <div class="ci-field ci-field--row">
    <label>保存后刷新界面（重载，看着像重启，默认关）</label>
    <input id="setRefresh" type="checkbox" class="b3-switch fn__flex-inline" ${s.refreshAfterSave === true ? "checked" : ""}>
  </div>
  <div class="ci-field ci-field--row">
    <label>保存后自动打开文档</label>
    <input id="setOpen" type="checkbox" class="b3-switch fn__flex-inline" ${s.openAfterSave ? "checked" : ""}>
  </div>
  <div class="ci-field ci-field--row">
    <label>把 AI 标签写成文档标签</label>
    <input id="setTags" type="checkbox" class="b3-switch fn__flex-inline" ${s.tagsToDoc ? "checked" : ""}>
  </div>
  <div class="ci-field">
    <label>自定义站点规则（JSON 数组，id 同名覆盖内置）</label>
    <textarea id="setRules" class="b3-text-field fn__block" rows="7" placeholder='[{"id":"example","hosts":["example.com"],"kind":"selector","title":["h1"],"body":[".article"]}]'>${esc(s.customRules)}</textarea>
  </div>

  <div class="ci-row ci-row--end">
    <button id="setSave" class="b3-button b3-button--outline">保存设置</button>
  </div>
</div>`;

    const dialog = new Dialog({
      title: "剪藏助手 · 设置",
      content: `<div class="b3-dialog__content">${content}</div>`,
      width: "780px",
      height: "82vh",
    });

    const el = dialog.element;
    const $ = (sel) => el.querySelector(sel);

    /* ---------- 模型来源：思源内置 / 自定义 ---------- */
    const provBox = $("#setProvider");
    const syModelBox = $("#setSiYuanModel");
    const providers = siyuanProviders();
    provBox.innerHTML =
      providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("") ||
      `<option value="">（思源里还没配 AI 提供方）</option>`;
    if (s.ai.provider && providers.some((p) => p.id === s.ai.provider)) provBox.value = s.ai.provider;

    const syncModeBox = () => {
      const mode = $("#setMode").value;
      $("#aiSiyuanBox").classList.toggle("fn__none", mode !== "siyuan");
      $("#aiCustomBox").classList.toggle("fn__none", mode !== "custom");
    };

    const loadSyModels = async () => {
      const pid = provBox.value;
      if (!pid) {
        syModelBox.innerHTML = `<option value="">（无）</option>`;
        return;
      }
      syModelBox.innerHTML = `<option value="">加载中…</option>`;
      try {
        let names = await siyuanListModels(pid);
        if (!names.length) {
          const p = providers.find((x) => x.id === pid);
          names = (p && p.models) || [];
        }
        syModelBox.innerHTML =
          names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("") ||
          `<option value="">（这个提供方没有可用模型）</option>`;
        if (s.ai.model && names.includes(s.ai.model)) syModelBox.value = s.ai.model;
      } catch (e) {
        syModelBox.innerHTML = `<option value="">拉取失败：${esc(e.message)}</option>`;
      }
    };

    $("#setMode").addEventListener("change", syncModeBox);
    provBox.addEventListener("change", loadSyModels);
    syncModeBox();
    if ($("#setMode").value === "siyuan") loadSyModels();
    $("#ciRefreshSy").addEventListener("click", loadSyModels);

    $("#ciTestSy").addEventListener("click", async () => {
      const box = $("#ciTestSyMsg");
      box.textContent = "测试中…";
      const t0 = Date.now();
      try {
        const out = await siyuanChat(provBox.value, syModelBox.value, "只回答两个字：你好");
        box.textContent = `✓ ${Date.now() - t0}ms · 返回：${out.slice(0, 40)}`;
      } catch (e) {
        box.textContent = "✗ " + e.message;
      }
    });

    $("#ciRefreshCustom").addEventListener("click", async () => {
      const box = $("#ciTestCustomMsg");
      box.textContent = "拉取中…";
      try {
        const names = await remoteListModels($("#setBase").value, $("#setKey").value);
        $("#ciModelList").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
        box.textContent = names.length ? `✓ 共 ${names.length} 个模型，点模型框会出来` : "接口没返回模型列表";
      } catch (e) {
        box.textContent = "✗ " + e.message;
      }
    });

    $("#ciTestCustom").addEventListener("click", async () => {
      const box = $("#ciTestCustomMsg");
      const base = $("#setBase").value.trim().replace(/\/+$/, "");
      const model = $("#setModelInput").value.trim();
      if (!base || !model) {
        box.textContent = "先填基础 URL 和模型";
        return;
      }
      box.textContent = "测试中…";
      const t0 = Date.now();
      try {
        const r = await proxyJSON(
          base + "/chat/completions",
          { model, temperature: 0, messages: [{ role: "user", content: "只回答两个字：你好" }] },
          $("#setKey").value
        );
        if (r.status < 200 || r.status >= 300) {
          const msg = (r.json && (r.json.error?.message || r.json.message)) || r.text.slice(0, 120);
          throw new Error(`HTTP ${r.status}：${msg}`);
        }
        const out = (r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message.content) || "";
        box.textContent = `✓ ${Date.now() - t0}ms · 返回：${String(out).slice(0, 40)}`;
      } catch (e) {
        box.textContent = "✗ " + e.message;
      }
    });

    $("#setSave").addEventListener("click", async () => {
      const dbSel = $("#setDb");
      const picked = databases.find((d) => d.avId === dbSel.value);
      const next = {
        notebook: $("#setNotebook").value,
        pathTemplate: $("#setPath").value.trim() || DEFAULT_SETTINGS.pathTemplate,
        useAI: $("#setUseAI").checked,
        ai: {
          mode: $("#setMode").value,
          provider: $("#setProvider").value || s.ai.provider || "",
          model:
            $("#setMode").value === "siyuan"
              ? $("#setSiYuanModel").value || ""
              : $("#setModelInput").value.trim(),
          baseURL: $("#setBase").value.trim(),
          apiKey: $("#setKey").value.trim(),
        },
        promptTemplate: $("#setPrompt").value,
        aiMaxChars: Number($("#setMaxChars").value) || 6000,
        customRules: $("#setRules").value,
        openAfterSave: $("#setOpen").checked,
        tagsToDoc: $("#setTags").checked,
        localizeImages: $("#setImg").checked,
        saveToDb: $("#setUseDb").checked,
        docMode: $("#setDocMode").value,
        refreshAfterSave: $("#setRefresh").checked,
        dbAvId: picked ? picked.avId : "",
        dbBlockId: picked ? picked.blockId : "",
        dbName: picked ? picked.name : "",
      };
      if (next.customRules.trim()) {
        try {
          JSON.parse(next.customRules);
        } catch (e) {
          showMessage("自定义规则不是合法 JSON：" + e.message, 5000, "error");
          return;
        }
      }
      if (next.saveToDb && !next.dbAvId) {
        showMessage("选了「写入数据库」但没找到数据库，请在下拉里选一个", 4000, "error");
        return;
      }
      this.settings = next;
      await this.saveSettings();
      showMessage("设置已保存", 2000);
      dialog.destroy();
    });
  }
}

/* --------------------------------------------------------------- 样式 */
const STYLE = `
.ci-wrap { display: flex; flex-direction: column; gap: 10px; }
.ci-row { display: flex; gap: 8px; align-items: center; }
.ci-row--end { justify-content: flex-end; margin-top: 6px; }
.ci-sep { margin: 10px 0 2px; font-size: 12px; font-weight: 600; opacity: .7; border-top: 1px solid var(--b3-border-color); padding-top: 8px; }
.ci-box { border: 1px dashed var(--b3-border-color); border-radius: 6px; padding: 10px 10px 0; margin-bottom: 12px; }
.ci-status { font-size: 12px; color: var(--b3-theme-on-surface); opacity: .75; min-height: 18px; }
.ci-status.ci-error { color: var(--b3-theme-error); opacity: 1; }
.ci-status.ci-warn { color: var(--b3-card-warning-color); opacity: 1; }
.ci-status.ci-ok { color: var(--b3-theme-primary); opacity: 1; }
.ci-list { display: flex; flex-direction: column; gap: 10px; }
.ci-card { border: 1px solid var(--b3-border-color); border-radius: 6px; padding: 10px 12px; background: var(--b3-theme-background); }
.ci-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ci-title { font-size: 14px; font-weight: 600; }
.ci-state { font-size: 12px; }
.ci-state.ci-ok { color: var(--b3-theme-primary); }
.ci-state.ci-error { color: var(--b3-theme-error); }
.ci-meta { font-size: 12px; opacity: .6; margin: 4px 0; }
.ci-err { font-size: 12px; color: var(--b3-theme-error); }
.ci-warn { font-size: 12px; color: var(--b3-card-warning-color); margin: 4px 0; }
.ci-badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.ci-badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: var(--b3-theme-primary-lightest); }
.ci-badge--tag { background: var(--b3-font-background3); }
.ci-sum { margin: 4px 0 8px 0; padding-left: 18px; font-size: 13px; }
.ci-sum li { margin: 3px 0; }
.ci-body { max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; background: var(--b3-theme-surface); border-radius: 4px; padding: 8px; margin: 0; }
.ci-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.ci-field--row { flex-direction: row; align-items: center; justify-content: space-between; }
.ci-field label { font-size: 12px; opacity: .8; }
.ci-hint { font-size: 12px; opacity: .55; }
.sy-clip-dock { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.sy-clip-dock-title { font-size: 14px; font-weight: 600; }
.sy-clip-dock-hint { font-size: 12px; opacity: .6; line-height: 1.6; }
.sy-clip-dock .b3-button { width: 100%; }
`;

module.exports = class extends ClipPlugin {
  onload() {
    const style = document.createElement("style");
    style.id = "sy-clip-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
    return super.onload();
  }
};
