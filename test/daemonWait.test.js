const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { waitForDaemons } = require('../lib/daemonWait');
const { encodeAddress } = require('../lib/address');

const PASSWORD = 'super-secret-rpc-password';

// A controllable JSON-RPC server: mode 'ok' answers getpeerinfo, 'forbidden' answers 403, 'error' answers an RPC error.
function mockDaemon() {
    const state = { mode: 'ok', requests: 0 };
    const server = http.createServer((req, res) => {
        state.requests += 1;
        req.resume();
        req.on('end', () => {
            if (state.mode === 'forbidden') {
                res.writeHead(403).end();
            } else if (state.mode === 'error') {
                res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ result: null, error: { code: -28, message: 'Loading block index...' }, id: 1 }));
            } else {
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: [], error: null, id: 1 }));
            }
        });
    });
    const listen = (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
    const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    return { state, listen, close };
}

async function freePort() {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

const eventually = async (check, what, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
};

const daemonConfig = (port, host = '127.0.0.1') => ({ host, port, user: 'u', password: PASSWORD });

function waiter(daemons, options = {}) {
    const controller = new AbortController();
    const logs = [];
    let settled = null;
    const promise = waitForDaemons(daemons, { intervalMs: 30, log: (severity, message) => logs.push({ severity, message }), signal: controller.signal, ...options })
        .then(() => { settled = 'resolved'; }, () => { settled = 'cancelled'; });
    return { logs, controller, promise, settled: () => settled, cancel: () => { controller.abort(); return promise; } };
}

test('waits while the daemon is unavailable, then resolves once it answers', async () => {
    const port = await freePort();
    const w = waiter([daemonConfig(port)]);
    await eventually(() => w.logs.length > 0, 'the first warning');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(w.settled(), null, 'must not resolve while the daemon is down');

    const daemon = mockDaemon();
    await daemon.listen(port);
    await eventually(() => w.settled() === 'resolved', 'the wait to finish');
    assert.match(w.logs.at(-1).message, /Daemon RPC is healthy after \d+ attempt/);
    await daemon.close();
});

test('identical failures are logged once, not on every retry', async () => {
    const port = await freePort();
    const w = waiter([daemonConfig(port)], { logIntervalMs: 60000 });
    await eventually(() => w.logs.length >= 1, 'the first warning');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await w.cancel();
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0].message, /Waiting for daemon RPC, retrying every \d+s: 127\.0\.0\.1:\d+ offline/);
});

test('a repeated failure is logged again after the log interval and counts suppressed attempts', async () => {
    const port = await freePort();
    let clock = 0;
    const w = waiter([daemonConfig(port)], { logIntervalMs: 1000, now: () => clock });
    await eventually(() => w.logs.length === 1, 'the first warning');
    await new Promise((resolve) => setTimeout(resolve, 150));
    clock = 5000;
    await eventually(() => w.logs.length === 2, 'the second warning');
    await w.cancel();
    assert.match(w.logs[1].message, /identical attempt\(s\) not logged/);
});

test('a changed failure reason is logged immediately', async () => {
    const daemon = mockDaemon();
    daemon.state.mode = 'forbidden';
    const port = await daemon.listen();
    const w = waiter([daemonConfig(port)], { logIntervalMs: 60000 });
    await eventually(() => w.logs.length === 1, 'the 403 warning');
    daemon.state.mode = 'error';
    await eventually(() => w.logs.length === 2, 'the RPC error warning');
    await w.cancel();
    await daemon.close();
    assert.match(w.logs[0].message, /refused the request \(HTTP 403\).*RPC credentials and the daemon's RPC allow-list/);
    assert.match(w.logs[1].message, /RPC error -28: Loading block index/);
});

test('a DNS failure keeps retrying and never resolves', async () => {
    const w = waiter([daemonConfig(9026, 'no-such-host.invalid')]);
    await eventually(() => w.logs.length > 0, 'the DNS warning', 8000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(w.settled(), null);
    await w.cancel();
    assert.match(w.logs[0].message, /no-such-host\.invalid:9026 (request error|offline)/);
});

test('with several daemons it waits for every one of them', async () => {
    const up = mockDaemon();
    const upPort = await up.listen();
    const downPort = await freePort();
    const w = waiter([daemonConfig(upPort), daemonConfig(downPort)]);
    await eventually(() => w.logs.length > 0, 'a warning naming the down daemon');
    assert.match(w.logs[0].message, new RegExp(`127\\.0\\.0\\.1:${downPort} `));
    assert.ok(!w.logs[0].message.includes(`:${upPort} `));
    assert.equal(w.settled(), null);

    const down = mockDaemon();
    await down.listen(downPort);
    await eventually(() => w.settled() === 'resolved', 'both daemons healthy');
    await up.close();
    await down.close();
});

test('the RPC password never appears in the logs', async () => {
    const daemon = mockDaemon();
    daemon.state.mode = 'forbidden';
    const port = await daemon.listen();
    const w = waiter([daemonConfig(port), daemonConfig(await freePort())]);
    await eventually(() => w.logs.length > 0, 'a warning');
    await w.cancel();
    await daemon.close();
    assert.ok(!JSON.stringify(w.logs).includes(PASSWORD));
});

test('cancelling stops the retry timer', async () => {
    const port = await freePort();
    const w = waiter([daemonConfig(port)]);
    await eventually(() => w.logs.length > 0, 'a warning');
    await w.cancel();
    assert.equal(w.settled(), 'cancelled');
});

// Process-level: the real bin/pool.js against a daemon that is down and then comes up.
function startPool(env) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'pool.js')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { text: '', exit: null };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output.text += chunk; });
    child.on('exit', (code) => { output.exit = code; });
    return { child, output, stop: () => new Promise((resolve) => { if (output.exit !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

const canConnect = (port) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
});

test('pool process: stays up and silent on the Stratum port while the daemon is down, and proceeds once RPC answers', async () => {
    const daemonPort = await freePort();
    const stratumPort = await freePort();
    const pool = startPool({
        POOL_NETWORK: 'mainnet',
        POOL_ADDRESS: encodeAddress(60, Buffer.alloc(20, 7)),
        DAEMON_HOSTS: `127.0.0.1:${daemonPort}`,
        DAEMON_RPC_USER: 'u',
        DAEMON_RPC_PASSWORD: PASSWORD,
        STRATUM_PORT: String(stratumPort),
        DAEMON_RETRY_SECONDS: '1'
    });
    try {
        await eventually(() => /Waiting for daemon RPC/.test(pool.output.text), 'the waiting message');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(pool.output.exit, null, 'the pool must keep running');
        assert.equal(await canConnect(stratumPort), false, 'no Stratum listener before RPC is healthy');
        assert.ok(!/Stratum Pool Server Started|\[block\]/.test(pool.output.text));

        const daemon = mockDaemon();
        await daemon.listen(daemonPort);
        await eventually(() => /Daemon RPC is healthy/.test(pool.output.text), 'the healthy message', 10000);
        await daemon.close();
        assert.ok(!pool.output.text.includes(PASSWORD));
    } finally {
        await pool.stop();
    }
});

test('pool process: invalid configuration still exits immediately instead of retrying', async () => {
    const pool = startPool({ POOL_NETWORK: 'mainnet', POOL_ADDRESS: 'not-an-address', DAEMON_HOSTS: '127.0.0.1:9026', DAEMON_RPC_USER: 'u' });
    await eventually(() => pool.output.exit !== null, 'the pool to exit', 5000);
    assert.equal(pool.output.exit, 1);
    assert.match(pool.output.text, /Invalid pool configuration/);
    assert.match(pool.output.text, /DAEMON_RPC_PASSWORD is required/);
    assert.ok(!/Waiting for daemon RPC/.test(pool.output.text));
});

test('pool process: SIGTERM while waiting for the daemon exits 0 promptly', async () => {
    const pool = startPool({ POOL_NETWORK: 'mainnet', POOL_ADDRESS: encodeAddress(60, Buffer.alloc(20, 7)), DAEMON_HOSTS: `127.0.0.1:${await freePort()}`, DAEMON_RPC_USER: 'u', DAEMON_RPC_PASSWORD: PASSWORD });
    await eventually(() => /Waiting for daemon RPC/.test(pool.output.text), 'the waiting message');
    await pool.stop();
    assert.equal(pool.output.exit, 0);
    assert.match(pool.output.text, /SIGTERM received/);
});

test('pool process: an invalid DAEMON_RETRY_SECONDS is rejected at startup', async () => {
    const pool = startPool({ POOL_NETWORK: 'mainnet', POOL_ADDRESS: encodeAddress(60, Buffer.alloc(20, 7)), DAEMON_HOSTS: '127.0.0.1:9026', DAEMON_RPC_USER: 'u', DAEMON_RPC_PASSWORD: PASSWORD, DAEMON_RETRY_SECONDS: '0' });
    await eventually(() => pool.output.exit !== null, 'the pool to exit', 5000);
    assert.equal(pool.output.exit, 1);
    assert.match(pool.output.text, /DAEMON_RETRY_SECONDS/);
    assert.ok(!pool.output.text.includes(PASSWORD));
});
