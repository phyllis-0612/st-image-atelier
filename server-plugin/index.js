'use strict';

const { registerRoutes } = require('./src/routes');

let registry;

async function init(router) {
  registry = registerRoutes(router);
  console.log('[画笺] Server Plugin 已加载');
}

async function exit() {
  registry = undefined;
  console.log('[画笺] Server Plugin 已停止');
}

module.exports = {
  init,
  exit,
  info: {
    id: 'st-image-atelier',
    name: '画笺',
    description: '画笺：OpenAI Images 兼容生图、本地保存与画廊',
  },
};
