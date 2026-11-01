'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  info: invoke('app:info'),
  tools: { status: invoke('tools:status'), install: invoke('tools:install'), setPath: invoke('tools:setPath'), onInstallProgress: on('tools:installProgress') },
  settings: { set: invoke('settings:set') },
  dialog: { open: invoke('dialog:open'), save: invoke('dialog:save') },
  media: { probe: invoke('media:probe'), thumb: invoke('media:thumb') },
  items: { create: invoke('items:create') },
  menu: { preview: invoke('menu:preview'), themeThumb: invoke('menu:themeThumb') },
  project: { save: invoke('project:save'), open: invoke('project:open'), estimate: invoke('project:estimate') },
  author: {
    start: invoke('author:start'), cancel: invoke('author:cancel'), cancelShutdown: invoke('author:cancelShutdown'),
    onProgress: on('author:progress'), onLog: on('author:log'), onDone: on('author:done'), onFailed: on('author:failed'), onShutdown: on('author:shutdown'),
  },
  disc: { burners: invoke('disc:burners'), erase: invoke('disc:erase'), burnIso: invoke('disc:burnIso') },
  shell: { open: invoke('shell:open'), show: invoke('shell:show'), external: invoke('shell:external') },
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
});
