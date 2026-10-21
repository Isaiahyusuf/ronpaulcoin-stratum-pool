'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MiningStats, HASHES_PER_DIFFICULTY } = require('../lib/miningStats');

function createStore(t, now) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-mining-stats-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { file: path.join(directory, 'stats.sqlite'), store: new MiningStats(path.join(directory, 'stats.sqlite'), { now }) };
}

test('persists share outcomes and only counts daemon-confirmed main-chain blocks', (t) => {
    let timestamp = 1_800_000_000_000;
    const { file, store } = createStore(t, () => timestamp);
    const firstClient = {};
    const secondClient = {};
    store.connected(firstClient);
    store.connected(secondClient);
    store.authorized(firstClient, true, 'reward-address.rig-a');
    store.authorized(secondClient, true, 'reward-address.rig-a');

    store.recordShare(true, { worker: 'reward-address.rig-a', difficulty: 2 });
    store.recordShare(false, { worker: 'reward-address.rig-a', error: 'job not found' });
    store.recordShare(false, { worker: 'reward-address.rig-a', error: 'duplicate share' });
    store.recordShare(true, { worker: 'reward-address.rig-a', difficulty: 4, blockStatus: 'side chain', blockHash: 'a'.repeat(64), height: 10 });
    store.recordShare(true, { worker: 'reward-address.rig-a', difficulty: 1, blockStatus: 'accepted', blockHash: 'b'.repeat(64), height: 11 });

    let summary = store.summary();
    assert.equal(summary.connectedMiners, 2);
    assert.equal(summary.connectedWorkers, 1);
    assert.equal(summary.workerConnections, 2);
    assert.equal(summary.workerDisconnections, 0);
    assert.equal(summary.submittedShares, 5);
    assert.equal(summary.lastShareAt, new Date(timestamp).toISOString());
    assert.equal(summary.recentWorkerSessions.length, 2);
    assert.equal(summary.acceptedShares, 3);
    assert.equal(summary.staleShares, 1);
    assert.equal(summary.rejectedShares, 1);
    assert.equal(summary.blocksFound, 1);
    assert.equal(summary.lastBlock.hash, 'b'.repeat(64));
    assert.equal(summary.poolHashrate, null);
    assert.equal(JSON.stringify(summary).includes('reward-address'), false);

    store.disconnected(firstClient);
    store.authorized(secondClient, false, null);
    assert.equal(store.summary().connectedMiners, 0);
    assert.equal(store.summary().workerDisconnections, 2);
    timestamp += 600_000;
    summary = store.summary();
    assert.equal(summary.poolHashrate, 7 * HASHES_PER_DIFFICULTY / 600);
    store.close();

    const reopened = new MiningStats(file, { now: () => timestamp });
    t.after(() => reopened.close());
    summary = reopened.summary();
    assert.equal(summary.acceptedShares, 3);
    assert.equal(summary.staleShares, 1);
    assert.equal(summary.rejectedShares, 1);
    assert.equal(summary.blocksFound, 1);
    assert.equal(summary.connectedMiners, 0);
    assert.equal(summary.workerConnections, 2);
    assert.equal(summary.workerDisconnections, 2);
});

test('counts unauthenticated sessions as neither miners nor workers', (t) => {
    const { store } = createStore(t, () => 1_800_000_000_000);
    const client = {};
    store.connected(client);
    store.authorized(client, false, 'reward-address.not-authorized');
    assert.equal(store.summary().connectedMiners, 0);
    assert.equal(store.summary().connectedWorkers, 0);
    store.close();
});

test('requires an absolute database path', () => {
    assert.throws(() => new MiningStats('relative.sqlite'), /must be absolute/);
});

test('closes persisted authenticated sessions left open by an unclean restart', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-mining-stats-restart-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'stats.sqlite');
    let timestamp = 1_800_000_000_000;
    const firstRun = new MiningStats(file, { now: () => timestamp });
    const client = {};
    firstRun.connected(client);
    firstRun.authorized(client, true, 'reward-address.rig');
    firstRun.close();

    timestamp += 10_000;
    const restarted = new MiningStats(file, { now: () => timestamp });
    t.after(() => restarted.close());
    const summary = restarted.summary();
    assert.equal(summary.connectedMiners, 0);
    assert.equal(summary.workerConnections, 1);
    assert.equal(summary.workerDisconnections, 1);
    assert.equal(summary.recentWorkerSessions[0].disconnectedAt, new Date(timestamp).toISOString());
});
