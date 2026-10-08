// 只暴露窗口动作给页面，页面拿不到任何 Node 能力
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('floatApi', {
  close: () => ipcRenderer.send('float-close'),
  hide: () => ipcRenderer.send('float-hide'),                // 关卡片 = 隐藏窗口（壳不退，位置/模式都保着）
  resize: (w, h) => ipcRenderer.send('float-resize', w, h),  // 右下角拖拽柄：目标尺寸
  zoom: dir => ipcRenderer.send('float-zoom', dir),          // Ctrl+滚轮：+0.1 / -0.1
  setMode: mode => ipcRenderer.send('float-mode', mode),     // 卡片 ⇄ 水球：窗口尺寸切换在壳里做
  dragBegin: () => ipcRenderer.send('float-drag-begin'),     // 水球拖动起点（壳记下当前位置）
  dragBy: (dx, dy) => ipcRenderer.send('float-drag-by', dx, dy),
});
