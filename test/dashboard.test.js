'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
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
        assert.equal(body.pool.check, 'mining.subscribe');
        assert.deepEqual(body.pool.endpoint, { host: env.STRATUM_PUBLIC_HOST, port: 53914, protocol: 'Stratum TCP' });
        assert.equal(body.connection.loginFormat, `${env.POOL_ADDRESS}.<worker>`);
        assert.equal(body.mining.poolHashrate, null);
        assert.match(body.mining.unavailableReason, /feed is unavailable/);
        assert.equal(body.network.height, null);
        assert.equal(body.network.synchronization, 'unverified');
        assert.equal(JSON.stringify(body).includes(env.DAEMON_RPC_PASSWORD), false);
        assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });
});

test('status API returns validated activity stats without exposing private service configuration', async () => {
    const token = 'private-token-that-must-not-leak-123456';
    const privateUrl = 'http://stratum-pool.railway.internal:3334/internal/stats';
    const miningStats = {
        trackingSince: '2026-10-21T00:00:00.000Z',
        storage: 'available',
        poolHashrate: 1234,
        hashrateWindowSeconds: 600,
        connectedMiners: 2,
        connectedWorkers: 1,
        activeWorkers24h: 3,
        acceptedShares: 15,
        rejectedShares: 2,
        staleShares: 1,
        blocksFound: 0,
        lastBlock: null,
        recentActivity: [{ at: '2026-10-21T00:00:00.000Z', status: 'accepted', difficulty: 2, blockHeight: null }]
    };
    await withServer({
        env: { ...env, POOL_STATS_URL: privateUrl, POOL_STATS_TOKEN: token },
        probe: async () => true,
        statsFetch: async (endpoint) => {
            assert.deepEqual(endpoint, { url: privateUrl, token });
            return miningStats;
        }
    }, async (base) => {
        const response = await fetch(`${base}/api/status`);
        const body = await response.json();
        assert.equal(body.mining.acceptedShares, 15);
        assert.equal(body.mining.connectedWorkers, 1);
        assert.equal(body.mining.recentActivity[0].status, 'accepted');
        assert.equal(JSON.stringify(body).includes(token), false);
        assert.equal(JSON.stringify(body).includes('railway.internal'), false);
        assert.equal(JSON.stringify(body).includes(env.DAEMON_RPC_PASSWORD), false);
    });
});

test('status API fails closed to unavailable mining metrics if the private feed fails', async () => {
    await withServer({
        env: { ...env, POOL_STATS_URL: 'http://stratum-pool.railway.internal:3334/internal/stats', POOL_STATS_TOKEN: 'private-token-that-must-not-leak-123456' },
        probe: async () => true,
        statsFetch: async () => { throw new Error('private endpoint failure'); }
    }, async (base) => {
        const body = await (await fetch(`${base}/api/status`)).json();
        assert.equal(body.mining.trackingStatus, 'unavailable');
        assert.equal(body.mining.acceptedShares, null);
        assert.match(body.mining.unavailableReason, /feed is unavailable/);
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
        assert.equal(body.pool.error, 'The Stratum subscribe health check could not complete.');
    });
});

test('Stratum probe requires a valid subscribe response rather than TCP reachability alone', async () => {
    const probeServer = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            if (!buffer.includes('\n')) return;
            socket.write(`${JSON.stringify({ id: 1, result: [[], 'abcd', 4], error: null })}\n`);
        });
    });
    await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
    try {
        await withServer({
            env: { ...env, STRATUM_PUBLIC_HOST: '127.0.0.1', STRATUM_PUBLIC_PORT: String(probeServer.address().port) }
        }, async (base) => {
            const body = await (await fetch(`${base}/api/status`)).json();
            assert.equal(body.pool.status, 'reachable');
            assert.equal(body.pool.check, 'mining.subscribe');
        });
    } finally {
        await new Promise((resolve) => probeServer.close(resolve));
    }
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
    assert.throws(() => createDashboardServer({ env: { ...env, POOL_STATS_URL: 'https://public.example.com/stats', POOL_STATS_TOKEN: 'a'.repeat(64) } }), /private Railway/);
    assert.throws(() => createDashboardServer({ env: { ...env, POOL_STATS_TOKEN: 'a'.repeat(64) } }), /configured together/);
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
