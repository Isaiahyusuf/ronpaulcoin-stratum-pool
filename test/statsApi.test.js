'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createStatsApi } = require('../lib/statsApi');

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

test('private stats endpoint requires bearer authentication and never returns worker credentials', async () => {
    const token = 'a'.repeat(64);
    const expected = { acceptedShares: 12, connectedWorkers: 1 };
    const port = await unusedPort();
    const stats = { summary: () => expected };
    const api = createStatsApi({ stats, port, token });
    await api.listen();
    try {
        const unauthorized = await fetch(`http://127.0.0.1:${port}/internal/stats`);
        assert.equal(unauthorized.status, 401);
        const authorized = await fetch(`http://127.0.0.1:${port}/internal/stats`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(authorized.status, 200);
        assert.deepEqual(await authorized.json(), expected);
        assert.equal(authorized.headers.get('cache-control'), 'no-store');
        assert.equal((await fetch(`http://127.0.0.1:${port}/internal/stats`, { method: 'POST' })).status, 404);
    } finally {
        await api.close();
    }
});



test('rejects weak stats API configuration', () => {
    assert.throws(() => createStatsApi({ stats: {}, port: 0, token: 'a'.repeat(64) }), /port/);
    assert.throws(() => createStatsApi({ stats: {}, port: 3334, token: 'short' }), /token/);
});
