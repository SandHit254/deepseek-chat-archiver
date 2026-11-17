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

---

## 七、已知限制与风险

- **接口可能变更**。字段名做过兼容层（`chat_messages`/`messages`、`thinking`/`reasoning_content`、`signed_path`/`url`），但路径或结构大变时需要改 `core/normalize.ts` 与 `core/api.ts`。
- **`fetch_page` 分页行为被官方改过**。带分页参数时可能只回前 50 条且 `has_more` 恒为 `true`。本项目用「游标是否推进 + 是否有新数据 + 硬上限」三重条件判断终止，不单纯依赖 `has_more`。
- **附件签名有时效**。`signed_path` 指向 `files.deepseeksvc.com` 且带签名，必须在导出当时下载，隔天再导旧链接会失效。签名过期时接口回 HTML 错误页，本项目识别后跳过并记录，不会把错误页存成附件。
- **有风控**。对同一 cookie 的并发请求敏感。导出全程串行，每 5 个会话间隔 800ms。
- **单附件上限 200 MB**，超限跳过并记录，避免一个大文件拖垮整批。
- **合规**：只读取你自己的账号、纯本地处理、不上传任何第三方。DeepSeek 官方 ToS 未明确授权批量抓取，账号被限流的风险自负。

---

## 八、许可

仅供个人备份自有对话使用。