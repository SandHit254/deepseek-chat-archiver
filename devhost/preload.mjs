import { contextBridge, ipcRenderer } from 'electron'

/**
 * 扩展运行时的最小桩。
 *
 * 这里涉及一个关键机制问题，值得记下来：
 *
 * contextBridge.exposeInMainWorld 把对象暴露到 **主世界**（页面世界），
 * 而不是隔离世界。因此「主世界」里执行的 content.js 能看到 window.chrome，
 * 而「隔离世界」里的 preload 代码看不到业务对象——但 preload 自己可以
 * 直接用 ipcRenderer。
 *
 * 早期版本我误以为它只暴露到隔离世界，导致主世界的 content.js 拿不到
 * chrome.runtime 直接抛错。实测 hasChromeStub 为 false 才发现问题。
 *
 * 另外：如果页面本身已经定义了 window.chrome（Chromium 内核自带一个
 * 只读的 chrome 对象），直接 exposeInMainWorld('chrome', ...) 会冲突。
 * 所以这里把桩挂在非冲突的键上，再在页面世界用一段引导脚本合并过去。
 */

const bridge = {
  runtime: {
    /** 页面里没有真实扩展资源，getURL 直接返回相对路径 */
    getURL: (path) => path,

    sendMessage: (message) => ipcRenderer.invoke('ext:message', message),

    onMessage: {
      listeners: [],
      addListener: (handler) => {
        bridge.runtime.onMessage.listeners.push(handler)
      },
      removeListener: (handler) => {
        const index = bridge.runtime.onMessage.listeners.indexOf(handler)
        if (index >= 0) bridge.runtime.onMessage.listeners.splice(index, 1)
      },
    },
  },

  /** 调试宿主没有 downloads API，归档保存走主进程对话框 */
  downloads: {
    download: async () => {
      throw new Error('调试宿主不支持 chrome.downloads，归档保存走 archive:save')
    },
  },
}

// 挂到独立键上，避开页面自带的 window.chrome
contextBridge.exposeInMainWorld('__dsArchiverStub__', bridge)