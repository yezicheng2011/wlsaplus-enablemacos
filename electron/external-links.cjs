const { isForumUrl } = require('./forum-config.cjs');

const EXTERNAL_HELP_URLS = new Set([
  'https://wlsaplus.spacehubxyz.hk/guide/wechat/',
]);

function validateExternalHelpUrl(value) {
  if (typeof value !== 'string' || !(EXTERNAL_HELP_URLS.has(value) || isForumUrl(value))) {
    throw new Error('External help URL is not allowed.');
  }
  return value;
}

module.exports = { validateExternalHelpUrl };
