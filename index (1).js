'use strict';

const { registerRoutes } = require('./src/routes');

let registry;

async function init(router) {
  registry = registerRoutes(router);
  console.log('[Image Atelier] Server Plugin 已加载');
}

async function exit() {
  registry = undefined;
  console.log('[Image Atelier] Server Plugin 已停止');
}

module.exports = {
  init,
  exit,
  info: {
    id: 'st-image-atelier',
    name: 'Image Atelier',
    description: 'OpenAI Images 兼容生图、本地保存与画廊',
  },
};
