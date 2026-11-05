const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const files = require('../lib/files');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-preview-')));
const root = path.join(tmp, 'root');
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'hello');
fs.writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>');
fs.writeFileSync(path.join(root, 'sub', 'digits.txt'), '0123456789');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside-marker');
fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'link.txt'));
fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'sub', 'nested-link.txt'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('info: size of a file inside the root', () => {
  const r = files.info(root, 'sub/a.txt');
  assert.strictEqual(r.path, 'sub/a.txt'); assert.strictEqual(r.size, 5); assert.ok(r.mtime > 0);
});

test('info: missing files, folders and anything outside the root are refused', () => {
  assert.strictEqual(files.info(root, 'nope.txt').error, 'this file no longer exists');
  assert.strictEqual(files.info(root, 'sub').error, 'is a directory');
  assert.strictEqual(files.info(root, '../outside.txt').error, 'bad path');
  assert.strictEqual(files.info(root, 'link.txt').error, 'bad path');
});

test('an inline .html opens in a sandbox, so it cannot act as the dashboard', async () => {
  const server = http.createServer((req, res) => files.stream(root, 'page.html', res, true));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.strictEqual(res.headers.get('content-security-policy'), 'sandbox');
    await res.text();
  } finally { server.close(); }
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}

test('stream answers byte ranges, which a phone needs to play a video', async () => {
  await withServer((req, res) => files.stream(root, 'sub/digits.txt', res, true, req.headers.range), async url => {
    const part = await fetch(url, { headers: { range: 'bytes=2-4' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers.get('content-range'), 'bytes 2-4/10');
    assert.strictEqual(await part.text(), '234');
    const tail = await fetch(url, { headers: { range: 'bytes=-3' } });
    assert.strictEqual(await tail.text(), '789');
    const open = await fetch(url, { headers: { range: 'bytes=7-' } });
    assert.strictEqual(await open.text(), '789');
    const whole = await fetch(url);
    assert.strictEqual(whole.status, 200);
    assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(await whole.text(), '0123456789');
    const bad = await fetch(url, { headers: { range: 'bytes=20-30' } });
    assert.strictEqual(bad.status, 416);
    await bad.text();
  });
});

test('a zip keeps a nested symlink as a link, never the file it points to', { skip: !require('node:child_process').spawnSync('zip', ['-v']).stdout?.length }, async () => {
  await withServer((req, res) => files.zip(root, ['sub'], res, 'x.zip'), async url => {
    const body = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.ok(body.includes('nested-link.txt'));
    assert.ok(!body.includes('outside-marker'));
  });
});
