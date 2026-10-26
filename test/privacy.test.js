const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceFiles = [
  'admin.html',
  'admin-imgtc.html',
  'block-img.html',
  'whitelist-on.html',
  'index.html',
  'index-nuxt.html',
  'functions/utils/middleware.js',
];

describe('private deployment privacy', function () {
  it('does not include third-party telemetry endpoints', function () {
    const content = sourceFiles
      .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
      .join('\n');

    for (const marker of [
      'sentry-cdn.com',
      'ingest.us.sentry.io',
      'static.hotjar.com',
      'clarity.ms',
      'frozen-sentinel.pages.dev',
    ]) {
      assert.ok(!content.includes(marker), `unexpected telemetry marker: ${marker}`);
    }
  });

  it('uses a local homepage background instead of the Bing wallpaper API', function () {
    const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const bingProxy = path.join(root, 'functions/api/bing/wallpaper/index.js');
    assert.ok(homepage.includes("url('/bg.svg')"));
    assert.ok(!homepage.includes('/api/bing/wallpaper'));
    assert.ok(!homepage.includes('cn.bing.com'));
    assert.ok(!fs.existsSync(bingProxy));
  });
});
