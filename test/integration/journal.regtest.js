const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRegtestEnvironment } = require('../helpers/regtestEnv');
const { startPoolProcess } = require('../helpers/poolProcess');
const { connectWorker, nextJob, solveJob } = require('../helpers/poolMiner');

const PORT = 3337;
const regtest = createRegtestEnvironment({ stratumPort: PORT, difficulty: 0.000025 });
const { rpcA } = regtest;
const JOURNAL = `/tmp/blocks-${process.pid}.jsonl`;

const readJournal = () => (fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('block journal with the real pool process and regtest daemons', () => {
    const pools = [];
    const startPool = () => {
        const pool = startPoolProcess({
            ...regtest.poolEnv,
            BLOCK_JOURNAL_PATH: JOURNAL,
            BLOCK_RECHECK_INTERVAL_SECONDS: '1',
            BLOCK_RECHECK_CONFIRMATIONS: '3'
        });
        pools.push(pool);
        return pool;
    };
    after(async () => {
        for (const pool of pools) await pool.stop();
        fs.rmSync(JOURNAL, { force: true });
    });

    async function mineBlock(login) {
        const tip = await rpcA('getbestblockhash');
        const worker = await connectWorker(PORT, login);
        try {
            const job = await nextJob(worker, tip);
            const solved = await solveJob(worker, job.params);
            assert.deepEqual([solved.response.result, solved.response.error], [true, null]);
            await regtest.waitUntil(async () => (await rpcA('getbestblockhash')) === solved.hash, 'the solved block to become the tip');
            return solved.hash;
        } finally {
            worker.client.close();
        }
    }

    it('journals the intent before the outcome, then finalises the block once it is deep enough', async () => {
        const pool = startPool();
        await pool.waitForLog(/Stratum Pool Server Started/);
        const hash = await mineBlock(`${regtest.minerAddress}.journal`);

        await regtest.waitUntil(() => readJournal().some((e) => e.hash === hash && e.status === 'accepted'), 'the accepted journal line');
        const mine = readJournal().filter((e) => e.hash === hash);
        assert.deepEqual(mine.map((e) => e.status).slice(0, 2), ['submitting', 'accepted']);
        assert.match(mine[0].hex, /^[0-9a-f]+$/);
        assert.equal(mine[1].hex, undefined);

        await mineBlock(`${regtest.minerAddress}.journal`);
        await mineBlock(`${regtest.minerAddress}.journal`);
        await regtest.waitUntil(() => readJournal().some((e) => e.hash === hash && e.final), 'the block to be finalised', 30000);
        const finalLine = readJournal().find((e) => e.hash === hash && e.final);
        assert.ok(finalLine.confirmations >= 3);
    });

    it('re-checks an unfinished block after a pool restart and reports a block missing from the index as unresolved', async () => {
        const first = pools[0];
        await first.stop();
        const fakeHash = 'ab'.repeat(32);
        fs.appendFileSync(JOURNAL, JSON.stringify({ time: new Date().toISOString(), hash: fakeHash, height: 99, worker: 'w', status: 'submitting', hex: 'deadbeef' }) + '\n');

        const second = startPool();
        await second.waitForLog(new RegExp(`1 block\\(s\\) were not confirmed.*${fakeHash} \\(submitting\\)`));
        await second.waitForLog(new RegExp(`Block ${fakeHash} \\(height 99\\) changed from submitting to unresolved.*submitblock deadbeef`));
        const last = readJournal().filter((e) => e.hash === fakeHash).pop();
        assert.deepEqual([last.status, last.hex], ['unresolved', 'deadbeef']);
        assert.doesNotMatch(fs.readFileSync(JOURNAL, 'utf8'), /rejected/);
    });
});
