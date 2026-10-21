'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardServer, createRateLimiter } = require('../web/server');

const env = {
    STRATUM_PUBLIC_HOST: 'roundhouse.proxy.rlwy.net',
    STRATUM_PUBLIC_PORT: '53914',
    POOL_ADDRESS: 'RWapG1kayVW3S8HAqBTtQubCJCa2WzzQKb',
    PORT: '0',
    DAEMON_RPC_PASSWORD: 'never-return-this-secret'
};

async function withServer(options, callback) {
    const server = createDashboardServer(options);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

test('status API reports configured endpoint and clearly unavailable metrics without secrets', async () => {
    await withServer({ env, probe: async () => true, now: () => new Date('2026-10-21T00:00:00Z') }, async (base) => {
        const response = await fetch(`${base}/api/status`);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.pool.status, 'reachable');
        assert.deepEqual(body.pool.endpoint, { host: env.STRATUM_PUBLIC_HOST, port: 53914, protocol: 'Stratum TCP' });
        assert.equal(body.connection.loginFormat, `${env.POOL_ADDRESS}.<worker>`);
        assert.equal(body.mining.poolHashrate, null);
        assert.match(body.mining.unavailableReason, /does not persist/);
        assert.equal(body.network.height, null);
        assert.equal(body.network.synchronization, 'unverified');
        assert.equal(JSON.stringify(body).includes(env.DAEMON_RPC_PASSWORD), false);
        assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });
});

test('status API reports endpoint offline when its TCP health probe fails', async () => {
    await withServer({ env, probe: async () => false }, async (base) => {
        const response = await fetch(`${base}/api/status`);
        assert.equal((await response.json()).pool.status, 'offline');
    });
});

test('status API distinguishes a failed health probe from a measured offline endpoint', async () => {
    await withServer({ env, probe: async () => { throw new Error('probe implementation failure'); } }, async (base) => {
        const body = await (await fetch(`${base}/api/status`)).json();
        assert.equal(body.pool.status, 'unavailable');
        assert.equal(body.pool.error, 'The TCP health check could not complete.');
    });
});

test('health check reports web process health without claiming pool or daemon health', async () => {
    await withServer({ env, probe: async () => { throw new Error('must not probe'); } }, async (base) => {
        const response = await fetch(`${base}/healthz`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'ok');
    });
});

test('unknown paths and unsupported methods are rejected safely', async () => {
    await withServer({ env, probe: async () => false }, async (base) => {
        assert.equal((await fetch(`${base}/.env`)).status, 404);
        const response = await fetch(`${base}/api/status`, { method: 'POST' });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
    });
});

test('required public configuration is validated', async () => {
    assert.throws(() => createDashboardServer({ env: { ...env, STRATUM_PUBLIC_PORT: 'invalid' } }), /STRATUM_PUBLIC_PORT/);
    assert.throws(() => createDashboardServer({ env: { ...env, STRATUM_PUBLIC_HOST: 'localhost;bad' } }), /STRATUM_PUBLIC_HOST/);
});

test('status endpoint rate limiter rejects requests beyond its configured budget', () => {
    let time = 0;
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000, now: () => time });
    assert.equal(limiter('client'), true);
    assert.equal(limiter('client'), true);
    assert.equal(limiter('client'), false);
    time = 1000;
    assert.equal(limiter('client'), true);
});
