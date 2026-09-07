'use strict';

const path = require('node:path');
const { AppError } = require('../utils/errors');

function resolveUserRoot(request) {
  const directories = request?.user?.directories;
  const candidate = directories?.root
    || directories?.data
    || request?.user?.profile?.directory;
  if (!candidate) {
    throw new AppError(
      'SERVER_PLUGIN_UNAVAILABLE',
      '当前 SillyTavern 未向插件提供用户数据目录',
      503,
    );
  }
  return path.resolve(candidate, 'st-image-atelier');
}

function userKey(request) {
  return String(
    request?.user?.profile?.handle
    || request?.user?.profile?.id
    || resolveUserRoot(request),
  );
}

module.exports = { resolveUserRoot, userKey };
