# 剪藏助手（sy-clip）

思源笔记插件：**粘贴链接（可批量） → 抓取正文 → AI 整理 → 写进思源，可选同时写进属性视图数据库**。

- 目录位置交给思源自己管（`filetree/createDocWithMd`，父目录自动建/复用，重名由思源处理）
- 抓取、模型调用、图片下载全走内核 `network/forwardProxy`，插件前端不吃 CORS
- 解析两层：内置站点规则 + 通用正文引擎，规则可自己加

## 安装

1. 把 `sy-clip` 文件夹放进工作区 `data/plugins/`（本机：`C:\Users\Solomon\SiYuan\data\plugins\sy-clip`）
2. 重启思源
3. 设置 → 集市 → 已下载 → 「剪藏助手」→ 启用

## 用法

点顶栏「剪藏」图标，或命令面板搜「剪藏链接」：

1. 一行一个链接（最多 20 条），`Ctrl/⌘ + Enter` 或点「抓取解析」
2. 每条会显示：标题、来源/作者/日期/字数/命中规则、AI 分类与标签、摘要、正文预览
3. 点单条「保存」，或「全部保存」

单个链接保存后会自动打开文档（可在设置里关掉）。

## 保存出来的文档

```markdown
## AI 摘要
- 要点 1 / 2 / 3

标签：`tag_one` `tag_two`

## 正文
（网页正文；开启图片本地化后图片进资源目录）

---

来源：[原始链接](URL) · 作者 · 日期
```

## 写入数据库（可选）

设置里勾「同时写入属性视图数据库」，选一个库。插件会：

1. `createDocWithMd` 建文档
2. `/av/addAttributeViewBlocks` 把这篇文档**绑定成数据库的一行**（点开就是全文，不再是空行）
3. `/av/batchSetAttributeViewBlockAttrs` 按列名填值

列名对应关系（库里没有的列自动跳过，所以换库也能用）：

| 列名（任一即可） | 写入内容 |
|---|---|
| `链接` `网址` `URL` | 原始链接（url 列） |
| `作者` `author` | 作者 |
| `日期` `date` | 发布日期（date 列，解析失败则跳过） |
| `分类` `category` | AI 分类 |
| `标签` `tags` | AI 标签（多选，逗号拆分） |
| `来源` `source` | 站点域名 |
| `摘要` `summary` | AI 摘要（纯文本列） |

## AI 两种接法

### 1. 思源内置 AI（推荐，不用填 Key）

插件直接调思源自己的 `/api/ai/chatGPT`：提供方和模型都从「设置 → AI」里读，模型列表走 `/api/ai/listModels`，**插件完全不接触你的密钥**（思源里存的 key 是加密的，插件也读不到）。

设置面板里：模型来源选「思源内置 AI」→ 选提供方 → 选模型 → 点「测试」看到 `✓ 1234ms · 返回：你好` 就通了。

### 2. 自定义 OpenAI 兼容接口

自己填 基础 URL / Key / 模型。基础 URL **只填到版本号**（如 `https://api.xxx.com/v1`），不要带 `/chat/completions`。

- 「刷新」会请求 `{基础URL}/models` 拉模型列表（填进模型框的候选）
- 「测试」会真发一次最小请求，回显耗时和回复；报错会写明 HTTP 码与原始错误消息

## 设置项

| 项 | 说明 |
|---|---|
| 笔记本 | 存到哪个笔记本 |
| 保存路径模板 | 默认 `/Clippings/{{title}}`（扁平，不再插日期目录）。变量：`{{title}} {{date}} {{year}} {{hostname}} {{author}} {{category}}`；**最后一段就是文档标题** |
| 启用 AI 整理 | 关掉也能用，只是不生成标题/摘要/标签/分类 |
| 模型来源 | 思源内置 / 自定义 |
| 正文字数上限 | 喂给模型的正文字数，默认 6000 |
| 同时写入属性视图数据库 | **默认开**。没选库时会在结果里提示「只存了文档」 |
| 图片下载到资源目录 | 正文图片下载后上传到思源 assets，正文里改写成资源路径；失败自动保留原链接 |
| 自定义站点规则 | JSON 数组，`id` 同名覆盖内置 |

## 内置规则

`x.com / twitter.com`（meta）、`mp.weixin.qq.com`、`github.com`、`bilibili.com`、`sspai.com`、`juejin.cn`、`zhihu.com`、`douban.com`。
其余网站走通用引擎：去噪音（nav/footer/aside/分享/推荐/广告…）→ 按「文本量 − 1.4×链接文字量 + 段落数」打分选正文容器 → 转 Markdown。

自定义规则示例：

```json
[
  {
    "id": "example",
    "hosts": ["example.com"],
    "kind": "selector",
    "title": ["h1"],
    "body": [".article-body", "article"],
    "author": [".author"],
    "date": ["meta[property='article:published_time']"]
  },
  {
    "id": "spa-with-meta",
    "hosts": ["some-spa.com"],
    "kind": "meta",
    "title": ["og:title"],
    "body": ["og:description"]
  }
]
```

## 文档放在哪（重要）

思源里“数据库条目”可以是文档，但有两种存在方式，对外表现完全不同：

| 设置 | 效果 | 接口 |
|---|---|---|
| **文件树里可见 + 表格一行**（默认） | 先建普通文档（文件树能看到），再绑成一行；路径由“保存路径模板”决定 | `filetree/createDocWithMd` + `av/addAttributeViewBlocks` |
| **只进表格**（跟顺手一样） | 文档作为数据库条目存在，**文件树里不建文件**；路径模板不生效 | `av/createAttributeViewItemWithMarkdown` |

## 表格刷新

思源里已打开的数据库块**不会因为内核 API 写入而自动重绘**（顺手当年之所以看起来即时，是因为它建的是条目文档，不是在背后往你正在看的表里插行）。

所以插件默认开启「**保存后刷新界面**」：写完库后 1.2 秒自动 reload 一次界面（等价于 F5，不用退出重登）。不想要就在设置里关掉，改成手动关掉文档再打开。

## 安全边界

插件**只做三件事**：新建文档（`filetree/createDocWithMd`）、把文档绑定成数据库行（`av/addAttributeViewBlocks`）、写单元格与文档属性（`av/batchSetAttributeViewBlockAttrs`、`attr/setBlockAttrs`），可选上传图片到 assets。

**代码里没有、以后也不会加**：`removeDoc` / `removeDocByID` / `removeDocs` / `moveDocs` / `moveDocsByID` / `renameDoc`。它不会删你的文档、不会移动你的目录。

每次保存前会在控制台打印一行 `[sy-clip] 即将写入 {...}`，出问题时能回溯到底写了什么。

## 已知限制

- **需要登录的页面抓不到**（小红书等）：走内核直连，没有浏览器会话
- 知乎有反爬，通常拿不到正文
- X 的公开页只有 `og:description`，长推文会截断，插件会在正文前标一行提示
- 图片本地化按张下载，图多的页面会慢一些；单篇上限 30 张

## 开发

```bash
node --check index.js
```

改完 `index.js` 后在思源里禁用再启用插件即可生效。
