/**
 * 构建期注入的常量声明。
 *
 * vite.config.ts 里通过 define 把 public/panel.html 与 panel.css 的内容
 * 内联成字符串字面量，供 content script 塞进 Shadow DOM。
 */
declare const __PANEL_HTML__: string
declare const __PANEL_CSS__: string