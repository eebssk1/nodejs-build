'use strict';

// Run only with the instrumented binary. No npm packages or external services.
// Let the event loop drain normally so GCC can flush profiles at process exit.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { Readable, Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setImmediate: yieldLoop } = require('node:timers/promises');
const { promisify } = require('node:util');
const { Script } = require('node:vm');
const { Worker } = require('node:worker_threads');
const zlib = require('node:zlib');

const rounds = Number(process.env.PGO_TRAINING_ROUNDS || 20);
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 200,
       'PGO_TRAINING_ROUNDS must be an integer from 1 to 200');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const pbkdf2 = promisify(crypto.pbkdf2);
const runChild = promisify(execFile);
const storage = new AsyncLocalStorage();
const payload = Buffer.from(JSON.stringify({
  name: 'Node PGO training',
  items: Array.from({ length: 32 }, (_, id) => ({ id, value: `item-${id}-中文` })),
}));

function trainCpu(round) {
  for (let i = 0; i < 2000; i++) {
    const object = JSON.parse(payload.toString());
    object.round = round;
    const buffer = Buffer.from(JSON.stringify(object));
    assert.equal(Buffer.from(buffer.toString('base64'), 'base64').length, buffer.length);
    crypto.createHash('sha256').update(buffer).digest();
    crypto.createHmac('sha256', 'pgo-key').update(buffer).digest();
    const url = new URL(`/api/items/${i}?q=中文&round=${round}`, 'http://localhost');
    url.searchParams.set('page', String(i % 10));
    assert.equal(url.pathname, `/api/items/${i}`);
    /items\/(\d+)/u.test(url.href);
  }

  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(cipher.getAuthTag());
  assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), payload);
  assert.deepEqual(zlib.inflateSync(zlib.deflateSync(payload)), payload);
  const brotliOptions = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
  assert.deepEqual(zlib.brotliDecompressSync(zlib.brotliCompressSync(payload, brotliOptions)), payload);

  // Exercise parsing, compilation, execution and allocation in V8, not just I/O.
  new Script(`(() => {
    const values = Array.from({ length: 500 }, (_, i) => ({ value: i }));
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += values[i % values.length].value;
    return sum;
  })()`).runInNewContext();
}

async function trainIo(directory, round) {
  const file = path.join(directory, `payload-${round}.json`);
  for (let i = 0; i < 10; i++) {
    await fs.writeFile(file, payload);
    assert.deepEqual(await fs.readFile(file), payload);
    assert.equal((await fs.stat(file)).size, payload.length);
    await fs.readdir(directory);
  }
  await fs.unlink(file);

  const [compressed] = await Promise.all([
    gzip(payload),
    pbkdf2('pgo-password', 'pgo-salt', 1000, 32, 'sha256'),
  ]);
  assert.deepEqual(await gunzip(compressed), payload);
  let bytes = 0;
  await pipeline(
    Readable.from(Array.from({ length: 32 }, () => payload)),
    new Transform({ transform(chunk, encoding, callback) { callback(null, chunk); } }),
    new Writable({
      write(chunk, encoding, callback) {
        bytes += chunk.length;
        callback();
      },
    }),
  );
  assert.equal(bytes, payload.length * 32);

  const emitter = new EventEmitter();
  let events = 0;
  emitter.on('item', () => events++);
  await storage.run(round, async () => {
    for (let i = 0; i < 100; i++) {
      await yieldLoop();
      assert.equal(storage.getStore(), round);
      emitter.emit('item');
    }
  });
  assert.equal(events, 100);
}

async function trainHttp(port, agent, round) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, agent, method: 'POST',
        path: `/api?round=${round}&item=${i}`,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            assert.equal(JSON.parse(Buffer.concat(chunks).toString()).items.length, 32);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
}

async function trainWorkers() {
  await Promise.all(Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      const { createHash } = require('node:crypto');
      for (let i = 0; i < 2000; i++) {
        createHash('sha256').update(JSON.stringify({ i, data: 'pgo' })).digest();
      }
      parentPort.postMessage('done');
    `, { eval: true });
    let received = false;
    worker.on('message', (message) => { received = message === 'done'; });
    worker.on('error', reject);
    // Await exit, not only the message: workers must finish before profiles flush.
    worker.on('exit', (code) => {
      if (code !== 0 || !received) reject(new Error(`PGO worker failed: ${code}`));
      else resolve();
    });
  })));
  const { stdout } = await runChild(process.execPath, ['-e',
    "require('node:fs'); import('node:path').then(() => console.log('pgo-child-ok'));",
  ]);
  assert.equal(stdout.trim(), 'pgo-child-ok');
}

async function main() {
  // All temporary files stay in the ignored profile directory, with cleanup.
  assert(process.env.PGO_DIR, 'PGO_DIR must point to the profile directory');
  const directory = await fs.mkdtemp(path.join(process.env.PGO_DIR, 'training-'));
  const agent = new http.Agent({ keepAlive: true });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    console.log(`PGO training: ${process.execPath}, ${rounds} rounds`);
    for (let round = 0; round < rounds; round++) {
      trainCpu(round);
      await trainIo(directory, round);
      await trainHttp(server.address().port, agent, round);
    }
    await trainWorkers();
    console.log('PGO training completed');
  } finally {
    agent.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
