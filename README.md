# DeepSeek Chat Archiver

DeepSeek 网页端对话归档扩展（Chrome / Edge，Manifest V3）。

批量导出账号下全部会话，输出 **Markdown / Word / 纯文本 / JSON** 四种格式，并分别保存**思考过程**、**联网引用**、**附件文件**与**分叉对话**。

---

## 一、与现成工具的区别

社区已有若干 DeepSeek 导出脚本（`pionxzh/deepseek-exporter`、`ceyaima/deepseek-exporter`、`xiaotong114/DeepSeek-Chat-Exporter-` 等）。本项目定位不是「再做一个一键导出」，而是**无损存档**，差异点在三处：

| 维度 | 常见实现 | 本项目 |
|---|---|---|
| 附件 | 内嵌为 base64 塞进文档 | 独立落盘到 `attachments/`，文档里用相对链接引用，另附 `_manifest.json` 记录文件与消息的对应关系 |
| 分叉对话 | Markdown 里直接丢弃未选中分支，或全部塞进 JSON | 主线保持单线可读 + 文末附录列出未选中分支 + JSON 保留完整 n 叉树 |
| 数据来源 | 部分依赖 DOM 滚动抓取 | 全部走只读接口，不受虚拟列表只渲染可视区的限制 |

---

## 二、产物结构

一次导出产出一个 zip：

```
DeepSeek 归档 2026-12-01/
├── manifest.json                    批次清单：会话列表、统计、失败原因
├── 001_分布式锁方案选型_a1b2c3d4/
│   ├── conversation.md              主线 + 思考过程（折叠）+ 文末分支附录
│   ├── conversation.docx
│   ├── conversation.txt             纯文本，用分隔线与缩进代替 Markdown 语法
│   ├── conversation.json            完整 n 叉树，含全部未选中分支
│   └── attachments/
│       ├── 001_架构草图.png
│       └── _manifest.json           附件 ↔ 消息 message_id 映射
└── 002_新对话_e5f6g7h8/
    └── ...
```

命名规则：`序号_安全标题_id 后 8 位`。序号保留时间排序，id 后缀防止同名会话互相覆盖（真实用户常有多条「新对话」）。

---

## 三、数据来源

不抓 DOM，全部走 `chat.deepseek.com` 的只读接口：

```
GET /api/v0/chat_session/fetch_page?count=N&lte_cursor.pinned=&lte_cursor.updated_at=
    → biz_data.chat_sessions[]          会话列表

GET /api/v0/chat/history_messages?chat_session_id=<id>
    → biz_data.chat_session + chat_messages[]    单会话全量消息
```

单条消息的结构（正文、思考、搜索、附件拆在不同 `fragment` 里）：

```js
{
  message_id, parent_id,            // 分支的骨骼，见下节
  role: 'USER' | 'ASSISTANT',
  inserted_at,
  files: [{ file_name, signed_path, mime_type, width, height, file_size }],
  fragments: [
    { type: 'REQUEST',  content },                     // 用户正文
    { type: 'RESPONSE', content },                     // 助手正文
    { type: 'THINK',    content, elapsed_secs },       // 思考过程
    { type: 'TOOL_SEARCH', results: [{ cite_index, title, url, site_name }] },
    { type: 'FILE',     files: [...] },
  ]
}
```

两点值得说明：

- **思考过程在接口里是全量的**。页面会折叠或截断，接口不会，所以走接口拿到的内容比页面上看到的多。
- **不需要处理 PoW**。`create_pow_challenge` 只作用于 `chat/completion` 与 `file/upload_file`，导出链路全是只读 GET。

---

## 四、分叉对话的处理

接口返回的 `chat_messages` 是**扁平存储的 n 叉树**：每条消息带 `parent_id`，用户每次「重新生成」或「编辑后重发」都会在同一父节点下新增兄弟节点，`chat_session.current_message_id` 指向当前选中的叶子。

```
u1 ──┬── a-old       重新生成产生，未选中
     └── a-current   ← current_message_id，用户实际看到的那条
          └── u2 ── a2
```

三种格式各有分工：

- **Markdown / DOCX**：只走激活路径（从 `current_message_id` 回溯到根再反转），保证可读。遇到分叉点插一行提示，未选中分支统一收进文末 `附录：未选中的分支`，按分叉点分组、按版本编号。
- **JSON**：`messages` 保留全部消息（用 `active` 字段标出主线）与 `parentId`，`tree` 给出嵌套结构，`session.branches` 列出每处分叉的版本清单。这是可回灌、可程序化处理的存档位。

Markdown 里不用 `<details>` 就地折叠分支，是因为折叠块在 `.txt` 与 `.docx` 中会退化成标签或层级混乱；主文档保持单线、分支走专门出口，三者都干净。

---

## 五、技术架构

```
src/
├── core/                 与浏览器无关的纯逻辑，可单测
│   ├── types.ts          接口原始结构与归一化后的稳定模型
│   ├── normalize.ts      所有字段兼容层（接口改版只改这里）
│   ├── tree.ts           n 叉树构建、激活路径回溯、分支归组
│   ├── markdown.ts       轻量 Markdown 块解析（md/txt/docx 共用）
│   ├── plan.ts           文件命名、目录规划、附件清单
│   └── render/           md.ts / text.ts / docx.ts / json.ts
├── content/              内容脚本：注入钩子、挂载面板
├── background/           service worker：token 保管、API 代理、附件下载、落盘
└── (public/)             面板 HTML/CSS、manifest、图标
```

关键设计决定：

1. **网络层收敛在 background**。它有 `host_permissions`，不受页面 CORS 限制，也不受 SPA 刷新影响。内容脚本与面板不直接发 HTTP。
2. **token 靠被动嗅探**。`pageHook.ts` 在页面主世界钩住 `fetch` / `XHR` 抄下 `Authorization`，转交 background 并只保存在内存。比去 `localStorage` 猜键名与加密方式稳，泄露面也更小。
3. **token 只存内存，不写 storage、不落盘**。关掉浏览器即失效。
4. **三种格式共用一份 Markdown 解析**。否则必然出现「md 里有代码块、docx 里变成一坨纯文本」的偏差。
5. **docx 在无 DOM 环境生成**。用 `docx` 库的 `Packer.toBlob`，不碰 Node 的 `fs` / `Buffer`，因此能在 service worker 里跑。

---

## 六、开发与构建

环境要求：Node 18+（实测 Node 22.14），npm。

```bash
npm install
npm run build        # 产出 dist/（可直接加载）
npm test             # 64 个单元与端到端测试
npm run typecheck    # tsc 严格模式
```

图标由脚本生成，无需手工准备：

```bash
node scripts/make-icons.mjs
```

### 加载扩展

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目的 `dist/` 目录
4. 打开 https://chat.deepseek.com 并登录
5. 点工具栏里的扩展图标，面板从右侧滑出

### 本地调试宿主（Electron）

侧载扩展时开发者看不到真实运行情况，只能靠截图与贴日志。`devhost/` 提供一个
内嵌浏览器宿主，加载**真实** `chat.deepseek.com` 并注入同样的脚本，本地即可跑通全链路：

```bash
cd devhost
npm install
npm start            # 或 npm run start:debug 直接打开 DevTools
```

- 启动后自动打开面板；`Ctrl+Shift+D` 可再次切换
- 页面控制台的 warn/error 会转发到终端
- 归档保存走系统保存对话框，产物落在你选的路径
- 它是调试工具，不是发布形态；正式分发仍用 MV3 扩展

---

## 七、网络层的关键约束（踩过的坑）

### 7.1 请求必须由页面主世界代发

**所有 API 请求必须由页面主世界代发，不能在 service worker 里直接 fetch。**

早期版本把请求放在 background 里，用 `credentials: 'omit'` 直连
`chat.deepseek.com/api/v0/...`，结果稳定返回 **HTTP 400**。原因是该域名位于
华为云 WAF 之后，服务端要求：

| 要求 | service worker 直连 | 页面主世界代发 |
|---|---|---|
| Cookie（`HWWAFSESID` / `HWWAFSESTIME` 等） | 缺 | 浏览器自动带 |
| `Origin` / `Referer` | 需手工伪造 | 天然正确 |
| `Sec-Fetch-Site/Mode/Dest` | 缺失或不自洽 | 浏览器按同源补齐 |
| 客户端身份头（`x-client-platform` 等） | 需手工维护且会过期 | 页面自己就会带 |

所以现在的分工是：`pageHook.ts` 负责真正的 `fetch`（`credentials: 'include'`，
与用户正常操作页面完全一致），`requester.ts` 只把请求意图转达过去。
**改这里之前先想清楚：一旦把请求移出页面上下文，400 就会回来。**

判据：修好后错误从 `HTTP 400` 变成 `INVALID_TOKEN`（未登录时），说明请求已经
穿过 WAF 到达业务层。

### 7.2 Shadow DOM 的三条约束

面板挂在 Shadow DOM 内，以下三点必须遵守，否则会出现「样式全丢」「面板卡死」
这类看起来毫不相关的故障：

1. **CSS 变量定义在 `:host`**，不能写 `:root` —— shadow tree 里没有 `:root`
   节点，所有 `var(--x)` 会静默失效，表现为配色/间距/圆角全部丢失。
2. **元素查找必须从 shadow root 开始**，不能用 `document.querySelector` ——
   后者查不到 shadow tree 内部，会抛「面板元素缺失」并让整个面板停在加载态。
3. **`[hidden]` 需要 `display: none !important`** —— 浏览器默认的 `[hidden]`
   规则优先级极低，会被 `.ds-btn { display: inline-flex }` 之类的自定义样式覆盖，
   表现为「明明设了 hidden 却还在显示」。

### 7.3 附件下载的 `ty` 参数（必填）

附件地址形如 `https://files.deepseeksvc.com/api/file?file_id=…&state=…`，其中
**`ty` 是必填参数**，服务端只接受三个值：

| `ty` | 含义 | 适用 |
|---|---|---|
| `p` | 预览 | 图片（网页端就这么取） |
| `t` | 文本 | 部分文本类资源 |
| `r` | 原始 | 文档（xlsx / json / txt / pdf…） |

实测报错（这是唯一可靠的依据，官方无文档）：

```
不带 ty     → 400 missing field `ty`
ty=o        → 400 ty: unknown variant `o`, expected one of `p`, `t`, `r`
ty=p（文档） → 400（无 body）
ty=r（文档） → 200，返回原始字节
```

类型判断依据 `file_name` / `mime_type` / 扩展名，三者都可能缺失，所以下载时
做了回退：第一次失败就在 `p` 与 `r` 之间换一种再试。**不能「删掉 ty 重试」**，
那必然报 `missing field ty`。

> 实测记录：修复前 34 个附件里有 5 个文档（xlsx/json/txt）全部 400；修复后
> 42 个附件全部下载成功，包括 3 个 xlsx、1 个 1 MB 的 json、1 个 txt。

### 7.4 附件清单的字段要在下载后回填

接口返回的 `mime_type` 与 `file_size` 实测**全为空 / 不可信**。因此
`attachments/_manifest.json` 必须在下载完成后再写，用实际拿到的
`content-type` 与 `byteLength` 回填，否则清单里类型为空、大小与实际不符。

### 7.5 调试宿主里的 chrome 桩

`devhost/` 用 `contextBridge.exposeInMainWorld` 暴露桩对象，注意它暴露到的是
**主世界**；而 Chromium 页面自带一个只读的 `window.chrome`，不能整体覆盖，
只能 `Object.defineProperty` 修补其 `runtime` 属性。桩先挂在
`__dsArchiverStub__` 上，再由引导脚本合并过去。

---

## 八、已知限制与风险

- **接口可能变更**。字段名做过兼容层（`chat_messages`/`messages`、`thinking`/`reasoning_content`、`signed_path`/`url`），但路径或结构大变时需要改 `core/normalize.ts` 与 `core/api.ts`。
- **`fetch_page` 分页行为被官方改过**。带分页参数时可能只回前 50 条且 `has_more` 恒为 `true`。本项目用「游标是否推进 + 是否有新数据 + 硬上限」三重条件判断终止，不单纯依赖 `has_more`。
- **附件签名有时效**。`signed_path` 指向 `files.deepseeksvc.com` 且带 `state` 签名，必须在导出当时下载。签名失效时接口回 HTML 错误页或 400，本项目识别后跳过并记录，不会把错误页存成附件。
- **`ty` 参数必须按类型给对**（见 7.3）。给错会让整个附件 400，且响应体常常是空的，很难凭空猜出原因。已实现 `p`/`r` 自动回退。
- **有风控**。对同一 cookie 的并发请求敏感。导出全程串行，每 5 个会话间隔 800ms。
- **单附件上限 200 MB**，超限跳过并记录，避免一个大文件拖垮整批。
- **Shadow DOM 相关约束**：面板挂在 Shadow DOM 内，因此
  ① CSS 变量必须定义在 `:host`（`:root` 在 shadow tree 里不匹配）；
  ② 元素查找不能用 `document.querySelector`，必须从 shadow root 查；
  ③ `[hidden]` 需要 `display:none !important` 才能压过自定义 `display`。
- **合规**：只读取你自己的账号、纯本地处理、不上传任何第三方。DeepSeek 官方 ToS 未明确授权批量抓取，账号被限流的风险自负。

---

## 九、许可

仅供个人备份自有对话使用。