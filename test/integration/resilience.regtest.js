const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createRegtestEnvironment } = require('../helpers/regtestEnv');
const { startPoolProcess } = require('../helpers/poolProcess');
const { connectWorker, nextJob, solveJob } = require('../helpers/poolMiner');
const { requestFault } = require('../helpers/control');

const regtest = createRegtestEnvironment({ stratumPort: 3333, difficulty: 0.000025 });
const { rpcA, rpcB } = regtest;
const poolEnv = {
    ...regtest.poolEnv,
    POOL_FAIL_CLOSED_ON_TEMPLATE_FAILURE: 'false',
    JOB_REBROADCAST_SECONDS: '3',
    BLOCK_SUBMIT_ATTEMPTS: '5',
    BLOCK_SUBMIT_RETRY_MS: '1000'
};
const NODES = ['rpc-a', 'rpc-b'];

describe('pool behaviour when daemons fail and recover', () => {
    let pool;
    let worker;

    const startPool = async (env = poolEnv) => {
        const started = startPoolProcess(env);
        await started.waitForLog(/Stratum Pool Server Started/, 30000);
        return started;
    };

    const waitForDaemonsReady = async () => {
        await regtest.waitUntil(async () => {
            try {
                await Promise.all([rpcA('getblocktemplate'), rpcB('getblockcount')]);
                return (await rpcB('getblockcount')) === (await rpcA('getblockcount'));
            } catch {
                return false;
            }
        }, 'both daemons to answer and agree on the chain', 90000);
    };

    const heights = () => Promise.all([rpcA('getblockcount'), rpcB('getblockcount')]);

    const mineThroughPool = async (session, extraNonce2 = '00000001') => {
        const tip = await rpcA('getbestblockhash');
        const height = (await rpcA('getblockcount')) + 1;
        const job = await nextJob(session, tip);
        const solved = await solveJob(session, job.params, extraNonce2);
        assert.deepEqual([solved.response.result, solved.response.error], [true, null]);
        await regtest.waitUntil(async () => (await heights()).every((h) => h === height), `both nodes at height ${height}`);
        assert.equal(await rpcA('getbestblockhash'), solved.hash);
        assert.equal(await rpcB('getbestblockhash'), solved.hash);
        return { ...solved, height };
    };

    before(async () => {
        pool = await startPool();
        worker = await connectWorker(regtest.stratumPort, `${regtest.minerAddress}.resilience`);
    });

    after(async () => {
        for (const node of NODES) {
            await requestFault('unpause', node).catch(() => {});
            await requestFault('connect', node).catch(() => {});
        }
        if (worker) worker.client.close();
        if (pool) await pool.stop();
    });

    it('mines a baseline block through the pool', async () => {
        const block = await mineThroughPool(worker);
        console.log(`      baseline block at height ${block.height}`);
    });

    it('keeps working through the reachable daemon while the other is unreachable', async () => {
        const logStart = pool.lines.length;
        await requestFault('disconnect', 'rpc-b');
        await pool.waitForLog(/getblocktemplate call failed for daemon instance 1/, 20000, logStart);
        assert.ok(pool.isRunning());

        const tip = await rpcA('getbestblockhash');
        const job = await nextJob(worker, tip);
        const solved = await solveJob(worker, job.params);
        assert.deepEqual([solved.response.result, solved.response.error], [true, null]);
        await regtest.waitUntil(async () => (await rpcA('getbestblockhash')) === solved.hash, 'node A to accept the block');
        await pool.waitForLog(/rpc error with daemon instance 1 when submitting block/, 20000, logStart);
        await pool.waitForLog(new RegExp(`\\[block\\] height=\\d+ hash=${solved.hash}`), 20000, logStart);

        await requestFault('connect', 'rpc-b');
        await regtest.waitUntil(async () => (await rpcB('getbestblockhash')) === solved.hash, 'node B to catch up', 90000);
    });

    it('retries a block found while no daemon is reachable and reports it once a daemon returns', async () => {
        const tip = await rpcA('getbestblockhash');
        const [heightBefore] = await heights();
        const job = await nextJob(worker, tip);

        const logStart = pool.lines.length;
        for (const node of NODES) await requestFault('disconnect', node);
        await pool.waitForLog(/getblocktemplate call failed/, 20000, logStart);
        assert.ok(pool.isRunning());

        const found = await solveJob(worker, job.params, '00000009');
        assert.equal(found.response.error, null);
        await pool.waitForLog(/rpc error with daemon instance \d when submitting block/, 20000, logStart);
        assert.ok(pool.isRunning());
        assert.ok(!pool.lines.slice(logStart).some((line) => line.includes('[block]') && line.includes(found.hash)));

        for (const node of NODES) await requestFault('connect', node);
        await waitForDaemonsReady();
        await pool.waitForLog(new RegExp(`\\[block\\] height=${heightBefore + 1} hash=${found.hash}`), 30000, logStart);
        await regtest.waitUntil(async () => (await rpcB('getbestblockhash')) === found.hash, 'node B to receive the retried block');
        assert.equal(await rpcA('getbestblockhash'), found.hash);
        assert.equal((await heights())[0], heightBefore + 1);
    });

    it('stops retrying and logs the block for manual submission when daemons stay unreachable', async () => {
        const tip = await rpcA('getbestblockhash');
        const job = await nextJob(worker, tip, { timeoutMs: 30000 });
        const logStart = pool.lines.length;
        for (const node of NODES) await requestFault('disconnect', node);
        await pool.waitForLog(/getblocktemplate call failed/, 20000, logStart);

        const found = await solveJob(worker, job.params, '0000000b');
        assert.equal(found.response.error, null);
        await pool.waitForLog(new RegExp(`Block ${found.hash} could not be submitted after 5 attempts .*submitblock: [0-9a-f]{300,}`), 180000, logStart);
        await pool.waitForLog(new RegExp(`Block ${found.hash} is UNRESOLVED .*submitblock: [0-9a-f]{300,}`), 120000, logStart);
        assert.ok(pool.isRunning());

        for (const node of NODES) await requestFault('connect', node);
        await waitForDaemonsReady();
        assert.notEqual(await rpcA('getbestblockhash'), found.hash);
        const recovered = await mineThroughPool(worker, '0000000c');
        console.log(`      mined at height ${recovered.height} after an abandoned submission`);
    });

    it('times out requests to a hung daemon and recovers when it answers again', async () => {
        const logStart = pool.lines.length;
        for (const node of NODES) await requestFault('pause', node);
        await pool.waitForLog(/RPC request timed out/, 30000, logStart);
        assert.ok(pool.isRunning());
        for (const node of NODES) await requestFault('unpause', node);
        await waitForDaemonsReady();
        const block = await mineThroughPool(worker, '0000000b');
        console.log(`      mined at height ${block.height} after the daemons were paused and resumed`);
    });

    it('recovers after each daemon restarts with its chain data intact', async () => {
        for (const node of NODES) {
            const [heightBefore] = await heights();
            await requestFault('restart', node);
            await waitForDaemonsReady();
            assert.ok((await heights()).every((h) => h === heightBefore), `${node} kept its chain across the restart`);
            assert.ok(pool.isRunning());
            const block = await mineThroughPool(worker, '0000000c');
            assert.equal(block.height, heightBefore + 1);
        }
    });

    it('rejects a job that a second worker has already replaced, then continues on the new tip', async () => {
        const other = await connectWorker(regtest.stratumPort, `${regtest.minerAddress}.other`);
        try {
            const staleJob = await nextJob(worker, await rpcA('getbestblockhash'));
            const replacing = await mineThroughPool(other);
            const currentJob = await nextJob(worker, replacing.hash);

            const stale = await worker.client.request('mining.submit', [
                worker.login, staleJob.params[0], '0000000d', staleJob.params[7], '00000001'
            ]);
            assert.equal(stale.result, null);
            assert.equal(stale.error[0], 21);

            const solved = await solveJob(worker, currentJob.params, '0000000e');
            assert.deepEqual([solved.response.result, solved.response.error], [true, null]);
            await regtest.waitUntil(async () => (await rpcB('getbestblockhash')) === solved.hash, 'both nodes on the new tip');
        } finally {
            other.client.close();
        }
    });

    it('closes miner connections on pool shutdown and a restarted pool serves the current tip', async () => {
        const stoppingPool = pool;
        await pool.stop();
        assert.deepEqual(await stoppingPool.waitForExit(), { code: 0, signal: null });
        assert.ok(stoppingPool.lines.some((line) => line.includes('SIGTERM received, stopping')));
        await worker.client.waitForClose();
        await assert.rejects(connectWorker(regtest.stratumPort, `${regtest.minerAddress}.resilience`), { code: 'ECONNREFUSED' });

        pool = await startPool();
        worker = await connectWorker(regtest.stratumPort, `${regtest.minerAddress}.resilience`);
        const block = await mineThroughPool(worker);
        await pool.waitForLog(new RegExp(`\\[block\\] height=${block.height} hash=${block.hash}`), 20000);
        console.log(`      mined at height ${block.height} after a pool restart`);
    });

    describe('startup failures', () => {
        const canConnect = (port) => new Promise((resolve) => {
            const socket = require('node:net').connect(port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
        });

        it('waits without exiting or listening while the daemon is unreachable, then starts serving once it returns', async () => {
            await requestFault('disconnect', 'rpc-a');
            let waiting;
            try {
                waiting = startPoolProcess({ ...poolEnv, DAEMON_HOSTS: 'rpc-a:18443', STRATUM_PORT: '3334', DAEMON_RETRY_SECONDS: '1' });
                await waiting.waitForLog(/Waiting for daemon RPC, retrying every 1s: rpc-a:18443/, 30000);
                await new Promise((resolve) => setTimeout(resolve, 3000));
                assert.ok(waiting.isRunning(), 'the pool must keep running while the daemon is down');
                assert.equal(await canConnect(3334), false, 'no Stratum listener before RPC is healthy');
                assert.ok(!waiting.lines.some((line) => /Stratum Pool Server Started/.test(line)));
            } finally {
                await requestFault('connect', 'rpc-a');
                await waitForDaemonsReady();
            }
            try {
                await waiting.waitForLog(/Daemon RPC is healthy/, 30000);
                await waiting.waitForLog(/Stratum Pool Server Started/, 60000);
                assert.equal(await canConnect(3334), true);
                assert.ok(!waiting.lines.join('\n').includes(poolEnv.DAEMON_RPC_PASSWORD));
            } finally {
                await waiting.stop();
            }
        });

        it('keeps retrying when the RPC credentials are wrong, never prints them, and opens no port', async () => {
            const wrongPassword = 'definitely-not-the-password';
            const failing = startPoolProcess({ ...poolEnv, DAEMON_RPC_PASSWORD: wrongPassword, STRATUM_PORT: '3335', DAEMON_RETRY_SECONDS: '1' });
            try {
                await failing.waitForLog(/refused the request \(HTTP 401\)/, 30000);
                await new Promise((resolve) => setTimeout(resolve, 2500));
                assert.ok(failing.isRunning());
                assert.equal(await canConnect(3335), false);
                const output = failing.lines.join('\n');
                assert.ok(!output.includes(wrongPassword) && !output.includes(poolEnv.DAEMON_RPC_PASSWORD));
            } finally {
                await failing.stop();
            }
        });

        it('closes Stratum when every daemon stops providing block templates', async () => {
            const failClosed = startPoolProcess({
                ...regtest.poolEnv,
                STRATUM_PORT: '3336',
                POOL_STATS_PORT: '13336'
            });
            let miner;
            try {
                await failClosed.waitForLog(/Stratum Pool Server Started/, 30000);
                miner = await connectWorker(3336, `${regtest.minerAddress}.failclosed`);
                for (const node of NODES) await requestFault('disconnect', node);

                await failClosed.waitForLog(/No configured daemon can provide a current block template/, 30000);
                assert.deepEqual(await failClosed.waitForExit(), { code: 1, signal: null });
                await miner.client.waitForClose();
            } finally {
                if (miner) miner.client.close();
                if (failClosed.isRunning()) await failClosed.stop();
                for (const node of NODES) await requestFault('connect', node);
                await waitForDaemonsReady();
            }
        });

        it('never logged the RPC password while running', () => {
            assert.ok(!pool.lines.join('\n').includes(poolEnv.DAEMON_RPC_PASSWORD));
        });
    });
});
