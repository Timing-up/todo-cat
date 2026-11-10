'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  cmd: (name, args) => ipcRenderer.invoke('cmd', name, args),
  snapshot: () => ipcRenderer.invoke('snapshot'),
  calendar: (view, anchor) => ipcRenderer.invoke('calendar', view, anchor),
  ui: (name, payload) => ipcRenderer.send('ui', name, payload),
  on: (channel, cb) => {
    if (!['state', 'expanded', 'toast'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
