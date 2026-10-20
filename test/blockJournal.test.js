const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBlockJournal, classify } = require('../lib/blockJournal');
const { loadPoolConfig } = require('../lib/poolConfig');

const HASH = 'a'.repeat(64);
const dirs = [];
const journals = [];

function setup(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    dirs.push(dir);
    const file = path.join(dir, 'sub', 'blocks.jsonl');
    const logs = [];
    let answers = [];
    const clock = { value: 1_000_000 };
    const make = () => {
        const journal = createBlockJournal({
            file,
            daemonCmd: (method, params, callback) => {
                assert.equal(method, 'getblock');
                setImmediate(() => callback(answers));
            },
            log: (severity, message) => logs.push([severity, message]),
            now: () => clock.value,
            ...options
        });
        journals.push(journal);
        return journal;
    };
    const lines = () => fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    return { file, logs, clock, make, lines, answer: (value) => { answers = value; } };
}

async function until(check, description) {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const main = (confirmations, hash = HASH) => ({ error: null, response: { hash, confirmations } });
const side = (hash = HASH) => ({ error: null, response: { hash, confirmations: -1 } });
const absent = { error: { code: -5, message: 'Block not found' }, response: null };
const silent = { error: { code: -32603, message: 'boom' }, response: null };

afterEach(() => {
    for (const journal of journals.splice(0)) journal.stop();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('classify', () => {
    it('lets any main-chain report win and keeps the confirmation depth', () => {
        assert.deepEqual(classify([side(), main(7)], HASH), { status: 'accepted', confirmations: 7, counts: { main: 1, side: 1, absent: 0, silent: 0, total: 2 } });
    });
    it('reports side chain, unresolved and no verdict', () => {
        assert.equal(classify([side(), absent], HASH).status, 'side chain');
        assert.equal(classify([absent, silent], HASH).status, 'unresolved');
        assert.equal(classify([silent, silent], HASH).status, null);
    });
    it('ignores a response for a different hash', () => {
        assert.equal(classify([main(5, 'b'.repeat(64))], HASH).status, null);
    });
});

describe('block journal', () => {
    const entry = { hash: HASH, height: 7, worker: 'w', status: 'accepted' };

    it('writes a submitting line with the full hex before the outcome, then drops the hex once accepted', () => {
        const t = setup();
        const journal = t.make();
        journal.record({ ...entry, status: 'submitting', hex: 'abcd' });
        journal.record(entry);
        const [first, second] = t.lines();
        assert.deepEqual([first.status, first.hex, second.status, second.hex], ['submitting', 'abcd', 'accepted', undefined]);
        assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
    });

    it('keeps the hex on every non-accepted line, falling back to the submitting hex', () => {
        const t = setup();
        const journal = t.make();
        journal.record({ ...entry, status: 'submitting', hex: 'abcd' });
        journal.record({ ...entry, status: 'unresolved', reason: 'r' });
        assert.equal(t.lines()[1].hex, 'abcd');
    });

    it('does not re-check a block that is still being submitted', async () => {
        const t = setup();
        const journal = t.make();
        t.answer([absent]);
        journal.record({ ...entry, status: 'submitting', hex: 'abcd' });
        await journal.recheck();
        assert.equal(t.lines().length, 1);
        assert.deepEqual(t.logs, []);
    });

    it('records a reorg when an accepted block leaves the main chain, with an error log', async () => {
        const t = setup();
        const journal = t.make();
        journal.record({ ...entry, status: 'submitting', hex: 'abcd' });
        journal.record(entry);
        t.answer([side(), side()]);
        await journal.recheck();
        const last = t.lines().pop();
        assert.deepEqual([last.status, last.hex], ['side chain', 'abcd']);
        assert.match(t.logs[0][1], /REORG: block a+ \(height 7\) is no longer on the main chain; it is now on a side chain/);
        assert.equal(t.logs[0][0], 'error');
    });

    it('reports a vanished accepted block as unresolved, not rejected, and carries the hex for recovery', async () => {
        const t = setup();
        const journal = t.make();
        journal.record({ ...entry, status: 'submitting', hex: 'abcd' });
        journal.record(entry);
        t.answer([absent, absent]);
        await journal.recheck();
        const last = t.lines().pop();
        assert.equal(last.status, 'unresolved');
        assert.match(last.reason, /does not prove the block is invalid/);
        assert.equal(last.hex, 'abcd');
        assert.doesNotMatch(JSON.stringify(t.lines()), /rejected/);
    });

    it('promotes a side-chain block that later joins the main chain and then finalises it once deep', async () => {
        const t = setup({ confirmDepth: 10 });
        const journal = t.make();
        journal.record({ ...entry, status: 'side chain' });
        t.answer([main(3)]);
        await journal.recheck();
        assert.equal(t.lines().pop().status, 'accepted');
        assert.match(t.logs[0][1], /now on the main chain after being side chain/);
        t.answer([main(9)]);
        await journal.recheck();
        assert.equal(journal.tracked().length, 1);
        t.answer([main(10)]);
        await journal.recheck();
        assert.equal(journal.tracked().length, 0);
        assert.deepEqual(t.lines().pop(), { time: new Date(1_000_000).toISOString(), hash: HASH, height: 7, worker: 'w', status: 'accepted', final: true, confirmations: 10 });
    });

    it('does not change state when no daemon gives a usable answer', async () => {
        const t = setup();
        const journal = t.make();
        journal.record(entry);
        t.answer([silent, silent]);
        await journal.recheck();
        assert.equal(t.lines().length, 1);
        assert.equal(journal.tracked()[0].status, 'accepted');
    });

    it('stops re-checking after the window, writes a final line and warns for an unresolved block', async () => {
        const t = setup({ maxAgeMs: 1000 });
        const journal = t.make();
        journal.record({ ...entry, status: 'unresolved', hex: 'abcd' });
        t.answer([absent]);
        t.clock.value += 1001;
        await journal.recheck();
        const last = t.lines().pop();
        assert.deepEqual([last.final, last.status, last.hex], [true, 'unresolved', 'abcd']);
        assert.equal(journal.tracked().length, 0);
        assert.match(t.logs[0][1], /still unresolved when re-checking stopped/);
    });

    it('restores unfinished blocks after a restart, warns about them and resolves them', async () => {
        const t = setup();
        const first = t.make();
        first.record({ ...entry, status: 'submitting', hex: 'abcd' });
        first.record({ ...entry, hash: 'b'.repeat(64), status: 'accepted' });
        first.record({ ...entry, hash: 'c'.repeat(64), status: 'accepted' });
        fs.appendFileSync(t.file, JSON.stringify({ hash: 'c'.repeat(64), status: 'accepted', final: true }) + '\nnot json\n');
        first.stop();

        t.answer([main(2)]);
        const second = t.make();
        second.start();
        await until(() => t.lines().some((l) => l.hash === HASH && l.status === 'accepted'), 'the restored block to be re-checked');
        assert.deepEqual(second.tracked().map((e) => e.hash).sort(), [HASH, 'b'.repeat(64)]);
        assert.ok(t.logs.some(([, m]) => /1 unreadable line/.test(m)));
        assert.ok(t.logs.some(([, m]) => /1 block\(s\) were not confirmed.*a+ \(submitting\)/.test(m)));
        assert.equal(t.lines().filter((l) => l.hash === HASH).pop().status, 'accepted');
    });

    it('recovers hex for a submission interrupted by a crash that never reached the index', async () => {
        const t = setup();
        t.make().record({ ...entry, status: 'submitting', hex: 'abcd' });
        t.answer([absent, absent]);
        const second = t.make();
        second.start();
        await until(() => t.lines().pop().status === 'unresolved', 'the interrupted block to be reported unresolved');
        const last = t.lines().pop();
        assert.deepEqual([last.status, last.hex], ['unresolved', 'abcd']);
        assert.ok(t.logs.some(([sev, m]) => sev === 'error' && /submitblock abcd/.test(m)));
    });

    it('survives an unwritable journal without throwing, and says so', () => {
        const t = setup();
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.mkdirSync(t.file);
        t.make().record(entry);
        assert.match(t.logs[0][1], /Block journal write failed.*NOT recorded/);
    });

    it('does not overlap re-check passes', async () => {
        const t = setup();
        let calls = 0;
        const journal = createBlockJournal({
            file: t.file,
            daemonCmd: (m, p, cb) => { calls++; setTimeout(() => cb([main(1)]), 30); },
            log: () => {}
        });
        journals.push(journal);
        journal.record({ ...entry, status: 'side chain' });
        await Promise.all([journal.recheck(), journal.recheck()]);
        assert.equal(calls, 1);
    });
});

describe('block journal configuration', () => {
    const base = { POOL_NETWORK: 'regtest', POOL_ADDRESS: 'rEWNzjT1XqB4YfT6DkSEmRcJZxPhNAVudw', DAEMON_HOSTS: 'rpc:1', DAEMON_RPC_USER: 'u', DAEMON_RPC_PASSWORD: 'p' };
    it('is off by default with documented defaults', () => {
        assert.deepEqual(loadPoolConfig(base).blockJournal, { path: '', intervalSeconds: 60, confirmations: 100, maxHours: 48 });
    });
    it('accepts an absolute path and tuned values', () => {
        const config = loadPoolConfig({ ...base, BLOCK_JOURNAL_PATH: '/data/blocks.jsonl', BLOCK_RECHECK_INTERVAL_SECONDS: '5', BLOCK_RECHECK_CONFIRMATIONS: '6', BLOCK_RECHECK_MAX_HOURS: '1' });
        assert.deepEqual(config.blockJournal, { path: '/data/blocks.jsonl', intervalSeconds: 5, confirmations: 6, maxHours: 1 });
    });
    it('rejects a relative path and invalid numbers', () => {
        assert.throws(() => loadPoolConfig({ ...base, BLOCK_JOURNAL_PATH: 'blocks.jsonl' }), /BLOCK_JOURNAL_PATH must be an absolute path/);
        assert.throws(() => loadPoolConfig({ ...base, BLOCK_RECHECK_INTERVAL_SECONDS: '0' }), /BLOCK_RECHECK_INTERVAL_SECONDS/);
        assert.throws(() => loadPoolConfig({ ...base, BLOCK_RECHECK_CONFIRMATIONS: 'x' }), /BLOCK_RECHECK_CONFIRMATIONS/);
    });
});
