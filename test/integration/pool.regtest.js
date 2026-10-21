const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createRegtestEnvironment } = require('../helpers/regtestEnv');
const { startPoolProcess } = require('../helpers/poolProcess');
const { StratumClient } = require('../helpers/stratumClient');
const miner = require('../helpers/testMiner');

const STRATUM_PORT = 3333;
const POOL_DIFFICULTY = 0.000025;
const regtest = createRegtestEnvironment({ stratumPort: STRATUM_PORT, difficulty: POOL_DIFFICULTY });
const { rpcA, rpcB } = regtest;

async function getPoolStats() {
    const response = await fetch(`http://127.0.0.1:${regtest.poolEnv.POOL_STATS_PORT}/internal/stats`, {
        headers: { Authorization: `Bearer ${regtest.poolEnv.POOL_STATS_TOKEN}` }
    });
    assert.equal(response.status, 200);
    return response.json();
}

async function waitForStats(check, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const stats = await getPoolStats();
        if (check(stats)) return stats;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${description}`);
}

async function connectMiner(login, { authorize = true, port = STRATUM_PORT } = {}) {
    const client = await StratumClient.connect(port);
    const subscribed = await client.request('mining.subscribe', ['regtest-test-miner/1.0']);
    assert.equal(subscribed.error, null);
    const [, extraNonce1, extraNonce2Size] = subscribed.result;
    let authorized = null;
    if (authorize) authorized = await client.request('mining.authorize', [login, 'x']);
    return { client, login, extraNonce1, extraNonce2Size, authorized };
}

const submit = (session, job, extraNonce2, ntime, nonce) =>
    session.client.request('mining.submit', [session.login, job.jobId, extraNonce2, ntime, nonce]);

const jobFromNotification = (message) => {
    const [jobId, prevhash, coinbase1, coinbase2, branch, version, bits, ntime, clean] = message.params;
    return { jobId, prevhash, coinbase1, coinbase2, branch, version, bits, ntime, clean, params: message.params };
};

describe('RonPaulCoin pool against two local regtest daemons', () => {
    let pool;
    let session;
    let firstJob;
    let template;
    let baseHeight;
    let target;
    const extraNonce2 = '00000001';

    before(async () => {
        pool = startPoolProcess(regtest.poolEnv);
        await pool.waitForLog(/Stratum Pool Server Started/, 30000);
    });

    after(async () => {
        if (session) session.client.close();
        if (pool) await pool.stop();
    });

    it('both daemons are peered regtest nodes', async () => {
        const [infoA, infoB] = await Promise.all([rpcA('getinfo'), rpcB('getinfo')]);
        assert.ok(infoA.connections >= 1 && infoB.connections >= 1);
        assert.equal(infoA.blocks, infoB.blocks);
        baseHeight = infoA.blocks;
    });

    it('pool connected to the daemons and logged the template it started from', async () => {
        template = await rpcA('getblocktemplate');
        target = BigInt(`0x${template.target}`);
        const heightLine = pool.lines.find((line) => line.includes('Current Block Height'));
        assert.ok(heightLine, 'pool startup summary missing');
        assert.match(heightLine, new RegExp(`Current Block Height:\\s+${template.height}\\b`));
        assert.equal(template.height, baseHeight + 1);
        assert.equal(template.coinbasevalue, 100000000 >> Math.floor(template.height / 150), 'regtest halves the subsidy every 150 blocks');
        assert.ok(pool.lines.some((line) => /Detected Reward Type:\s+POW/.test(line)));
    });

    it('rejects workers with invalid addresses and accepts address.worker logins', async () => {
        const badChecksum = regtest.minerAddress.slice(0, -1) + (regtest.minerAddress.endsWith('2') ? '3' : '2');
        const rejected = await connectMiner(`${badChecksum}.rig1`);
        assert.equal(rejected.authorized.result, false);
        rejected.client.close();

        const mainnetAddress = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
        const wrongNetwork = await connectMiner(`${mainnetAddress}.rig1`);
        assert.equal(wrongNetwork.authorized.result, false);
        wrongNetwork.client.close();

        session = await connectMiner(`${regtest.minerAddress}.rig1`);
        assert.equal(session.authorized.result, true);
        assert.equal(session.authorized.error, null);
        assert.match(session.extraNonce1, /^[0-9a-f]{8}$/);
        assert.equal(session.extraNonce2Size, 4);
        const stats = await waitForStats((value) => value.connectedMiners === 1, 'authenticated worker telemetry');
        assert.equal(stats.connectedWorkers, 1);
    });

    it('sends the pool difficulty and a mining.notify for the daemon template', async () => {
        const difficulty = await session.client.waitForNotification('mining.set_difficulty');
        assert.deepEqual(difficulty.params, [POOL_DIFFICULTY]);

        firstJob = jobFromNotification(await session.client.waitForNotification('mining.notify'));
        assert.equal(firstJob.clean, true);
        assert.equal(miner.swapWords(Buffer.from(firstJob.prevhash, 'hex')).toString('hex'),
            miner.reverse(Buffer.from(template.previousblockhash, 'hex')).toString('hex'));
        assert.equal(Buffer.from(firstJob.version, 'hex').readUInt32BE(), template.version);
        assert.equal(firstJob.bits, template.bits);
        assert.ok(parseInt(firstJob.ntime, 16) >= template.mintime);
        assert.ok(Math.abs(parseInt(firstJob.ntime, 16) - template.curtime) <= 30);
    });

    it('builds the coinbase transaction the daemon template calls for', () => {
        const candidate = miner.buildCandidate(firstJob.params, session.extraNonce1, extraNonce2);
        const tx = miner.parseTransaction(candidate.coinbase);

        assert.equal(tx.trailingBytes, 0);
        assert.equal(tx.version, 1);
        assert.equal(tx.lockTime, 0);
        assert.equal(tx.inputs.length, 1);
        const [input] = tx.inputs;
        assert.ok(input.previousTxid.equals(Buffer.alloc(32)));
        assert.equal(input.previousIndex, 0xffffffff);
        assert.equal(input.sequence, 0);
        assert.ok(input.scriptSig.length >= 2 && input.scriptSig.length <= 100);

        const heightPush = miner.heightPush(template.height);
        assert.ok(input.scriptSig.subarray(0, heightPush.length).equals(heightPush), 'height push must start the scriptSig');
        const extraNonces = Buffer.from(session.extraNonce1 + extraNonce2, 'hex');
        assert.ok(input.scriptSig.includes(extraNonces), 'extranonces must sit inside the scriptSig');

        assert.equal(tx.outputs.length, 1);
        assert.equal(tx.outputs[0].value, BigInt(template.coinbasevalue));
        assert.ok(miner.p2pkhHash160(tx.outputs[0].script).equals(regtest.poolHash160));
    });

    it('computes the merkle root over the coinbase and the template transactions', () => {
        const candidate = miner.buildCandidate(firstJob.params, session.extraNonce1, extraNonce2);
        const templateTxids = template.transactions.map((tx) => miner.reverse(Buffer.from(tx.hash, 'hex')));
        const expected = miner.merkleRootFromList([candidate.coinbaseTxid, ...templateTxids]);
        assert.ok(candidate.merkleRoot.equals(expected));
        assert.equal(firstJob.branch.length, 0);
    });

    describe('share validation', () => {
        const accepted = (pow) => pow > target && miner.shareDifficulty(pow) >= POOL_DIFFICULTY * 1.01;
        const belowDifficulty = (pow) => pow > target && miner.shareDifficulty(pow) < POOL_DIFFICULTY * 0.9;
        let candidate;
        let validShare;

        before(() => {
            candidate = miner.buildCandidate(firstJob.params, session.extraNonce1, extraNonce2);
            validShare = miner.findNonce(candidate, accepted);
        });

        it('accepts a share that meets the pool difficulty but not the network target', async () => {
            assert.ok(validShare.pow > target);
            const response = await submit(session, firstJob, extraNonce2, firstJob.ntime, miner.nonceHex(validShare.nonce));
            assert.deepEqual([response.result, response.error], [true, null]);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            assert.equal((await rpcA('getinfo')).blocks, baseHeight, 'a share below the network target must not create a block');
            const stats = await waitForStats((value) => value.acceptedShares >= 1, 'accepted share telemetry');
            assert.equal(stats.recentActivity[0].status, 'accepted');
        });

        it('rejects a duplicate submission', async () => {
            const response = await submit(session, firstJob, extraNonce2, firstJob.ntime, miner.nonceHex(validShare.nonce));
            assert.equal(response.result, null);
            assert.equal(response.error[0], 22);
        });

        it('rejects a share below the pool difficulty', async () => {
            const weak = miner.findNonce(candidate, belowDifficulty);
            const response = await submit(session, firstJob, extraNonce2, firstJob.ntime, miner.nonceHex(weak.nonce));
            assert.equal(response.result, null);
            assert.equal(response.error[0], 23);
            assert.match(response.error[1], /low difficulty/);
            const stats = await waitForStats((value) => value.rejectedShares >= 2, 'rejected share telemetry');
            assert.equal(stats.staleShares, 0);
        });

        it('classifies an unknown job submission as stale in persisted telemetry', async () => {
            const response = await submit(session, { ...firstJob, jobId: 'deadbeef' }, extraNonce2, firstJob.ntime, '00000002');
            assert.equal(response.error[0], 21);
            const stats = await waitForStats((value) => value.staleShares >= 1, 'stale share telemetry');
            assert.ok(stats.recentActivity.some((event) => event.status === 'stale'));
        });

        it('rejects non-hexadecimal fields instead of hashing a truncated header', async () => {
            const nonce = miner.nonceHex(validShare.nonce + 2);
            const cases = [
                ['extranonce2', [firstJob.jobId, 'zzzzzzzz', firstJob.ntime, nonce]],
                ['ntime', [firstJob.jobId, extraNonce2, 'zzzzzzzz', nonce]],
                ['nonce', [firstJob.jobId, extraNonce2, firstJob.ntime, 'zzzzzzzz']]
            ];
            for (const [label, params] of cases) {
                const response = await session.client.request('mining.submit', [session.login, ...params]);
                assert.equal(response.result, null, label);
                assert.equal(response.error[0], 20, label);
            }
        });

        it('treats hexadecimal case variants of an accepted share as duplicates', async () => {
            const other = miner.buildCandidate(firstJob.params, session.extraNonce1, '0000000a');
            let share;
            for (let start = 0; ; start = share.nonce + 1) {
                share = miner.findNonce(other, accepted, { start });
                if (/[a-f]/.test(miner.nonceHex(share.nonce))) break;
            }
            const nonce = miner.nonceHex(share.nonce);
            const first = await submit(session, firstJob, '0000000a', firstJob.ntime, nonce);
            assert.deepEqual([first.result, first.error], [true, null]);
            const upperNonce = await submit(session, firstJob, '0000000a', firstJob.ntime, nonce.toUpperCase());
            assert.equal(upperNonce.error[0], 22);
            const upperExtraNonce = await submit(session, firstJob, '0000000A', firstJob.ntime, nonce);
            assert.equal(upperExtraNonce.error[0], 22);
        });

        it('attributes shares to the authorized worker, not to the name sent with the submission', async () => {
            const rig = await connectMiner(`${regtest.minerAddress}.rigA`);
            const weak = miner.findNonce(miner.buildCandidate(firstJob.params, rig.extraNonce1, extraNonce2), belowDifficulty);
            const response = await rig.client.request('mining.submit', [
                `${regtest.minerAddress}.victim`, firstJob.jobId, extraNonce2, firstJob.ntime, miner.nonceHex(weak.nonce)
            ]);
            assert.equal(response.error[0], 23);
            rig.client.close();
            await pool.waitForLog(new RegExp(`\\[share-rejected\\] worker=${regtest.minerAddress}\\.rigA `), 5000);
            assert.ok(!pool.lines.some((line) => line.includes('worker=') && line.includes('.victim')));
        });

        it('rejects malformed field sizes and out-of-range times', async () => {
            const nonce = miner.nonceHex(validShare.nonce + 1);
            const cases = [
                ['extranonce2 of wrong size', [firstJob.jobId, '0001', firstJob.ntime, nonce], 20],
                ['ntime of wrong size', [firstJob.jobId, extraNonce2, '5f5e10', nonce], 20],
                ['nonce of wrong size', [firstJob.jobId, extraNonce2, firstJob.ntime, 'abcd'], 20],
                ['ntime before the template time', [firstJob.jobId, extraNonce2, '00000001', nonce], 20],
                ['ntime far in the future', [firstJob.jobId, extraNonce2, 'ffffffff', nonce], 20],
                ['unknown job id', ['deadbeef', extraNonce2, firstJob.ntime, nonce], 21]
            ];
            for (const [label, params, code] of cases) {
                const response = await session.client.request('mining.submit', [session.login, ...params]);
                assert.equal(response.result, null, label);
                assert.equal(response.error[0], code, label);
            }
        });

        it('rejects submissions from unauthorized and unsubscribed connections', async () => {
            const unauthorized = await connectMiner(null, { authorize: false });
            const noAuth = await submit(unauthorized, firstJob, extraNonce2, firstJob.ntime, '00000002');
            assert.equal(noAuth.error[0], 24);
            unauthorized.client.close();

            const client = await StratumClient.connect(STRATUM_PORT);
            await client.request('mining.authorize', [`${regtest.minerAddress}.rig2`, 'x']);
            const noSubscribe = await client.request('mining.submit', [`${regtest.minerAddress}.rig2`, firstJob.jobId, extraNonce2, firstJob.ntime, '00000002']);
            assert.equal(noSubscribe.error[0], 25);
            client.close();
        });

        it('survives structurally invalid messages and keeps serving miners', async () => {
            const badMessages = [
                '{"id":1,"method":"mining.submit"}\n',
                '{"id":2,"method":"mining.authorize"}\n',
                '{"id":3,"method":"mining.submit","params":[]}\n',
                '{"id":4,"method":"mining.submit","params":[1,2,3,4,5]}\n',
                '{"id":5,"method":"mining.authorize","params":[null,null]}\n',
                '{"id":6,"method":"mining.unknown","params":[]}\n',
                'null\n', '42\n', '[]\n'
            ];
            for (const message of badMessages) {
                const probe = await connectMiner(`${regtest.minerAddress}.probe`);
                probe.client.sendRaw(message);
                await new Promise((resolve) => setTimeout(resolve, 150));
                probe.client.close();
                assert.ok(pool.isRunning(), `pool died on ${message.trim()}`);
            }
            const healthy = await connectMiner(`${regtest.minerAddress}.after`);
            assert.equal(healthy.authorized.result, true);
            healthy.client.close();
        });

        it('disconnects clients that send non-JSON data or flood the socket', async () => {
            const garbage = await StratumClient.connect(STRATUM_PORT);
            garbage.sendRaw('this is not json\n');
            await garbage.waitForClose();

            const flood = await StratumClient.connect(STRATUM_PORT);
            flood.sendRaw('a'.repeat(20000));
            await flood.waitForClose();
            assert.ok(pool.isRunning());
        });
    });

    describe('block submission', () => {
        let blockShare;
        let solvedHeader;
        let solvedCandidate;

        it('submits a solved block through the pool and both daemons accept it', async () => {
            solvedCandidate = miner.buildCandidate(firstJob.params, session.extraNonce1, '00000002');
            blockShare = miner.findNonce(solvedCandidate, (pow) => pow <= target);
            solvedHeader = blockShare.header;

            const response = await submit(session, firstJob, '00000002', firstJob.ntime, miner.nonceHex(blockShare.nonce));
            assert.deepEqual([response.result, response.error], [true, null]);
            await pool.waitForLog(/\[block\] height=\d+ hash=[0-9a-f]{64}/, 15000);

            const expectedHash = miner.reverse(miner.sha256d(solvedHeader)).toString('hex');
            await regtest.waitUntil(async () => (await rpcA('getblockcount')) === baseHeight + 1, 'node A to reach the new height');
            await regtest.waitUntil(async () => (await rpcB('getblockcount')) === baseHeight + 1, 'node B to receive the block');
            assert.equal(await rpcA('getbestblockhash'), expectedHash);
            assert.equal(await rpcB('getbestblockhash'), expectedHash);
            const stats = await waitForStats((value) => value.blocksFound === 1, 'daemon-confirmed block telemetry');
            assert.equal(stats.lastBlock.hash, expectedHash);
            assert.equal(stats.lastBlock.height, baseHeight + 1);
        });

        it('stored the coinbase and header exactly as the independent miner built them', async () => {
            const hash = await rpcB('getbestblockhash');
            const block = await rpcB('getblock', [hash]);
            assert.equal(block.height, baseHeight + 1);
            assert.equal(block.previousblockhash, template.previousblockhash);
            assert.equal(block.merkleroot, miner.reverse(solvedCandidate.coinbaseTxid).toString('hex'));
            assert.deepEqual(block.tx, [miner.reverse(solvedCandidate.coinbaseTxid).toString('hex')]);
            assert.equal(block.nonce, blockShare.nonce);
            assert.equal(block.bits, template.bits);
        });

        it('announces a new job built on the accepted block and treats the old job as stale', async () => {
            const hash = await rpcA('getbestblockhash');
            const next = await session.client.waitFor(
                (m) => m.method === 'mining.notify' && miner.swapWords(Buffer.from(m.params[1], 'hex')).equals(miner.reverse(Buffer.from(hash, 'hex'))),
                15000, 'notify on the new tip'
            );
            assert.equal(next.params[8], true);

            const stale = await submit(session, firstJob, '00000003', firstJob.ntime, '00000001');
            assert.equal(stale.result, null);
            assert.equal(stale.error[0], 21);
        });

        it('lets the daemon report a rejection for a block with invalid proof of work', async () => {
            const hexBlock = (header) => Buffer.concat([header, Buffer.from([1]), solvedCandidate.coinbase]).toString('hex');
            const weakNonce = miner.findNonce(solvedCandidate, (pow) => pow > target, { start: 0 });
            const response = await rpcA('submitblock', [hexBlock(weakNonce.header)]);
            assert.equal(response, 'rejected');
        });
    });

    describe('stratum compatibility', () => {
        it('answers optional miner requests and still serves a normal session', async () => {
            const client = await StratumClient.connect(STRATUM_PORT);
            const configure = await client.request('mining.configure', [['version-rolling'], { 'version-rolling.mask': 'ffffffff' }]);
            assert.deepEqual(configure.result, { 'version-rolling': false });
            assert.equal(configure.error, null);

            const extranonce = await client.request('mining.extranonce.subscribe', []);
            assert.equal(extranonce.result, false);
            assert.equal(extranonce.error[0], 20);

            const suggest = await client.request('mining.suggest_difficulty', [1]);
            assert.equal(suggest.error[0], 20);

            const subscribed = await client.request('mining.subscribe', ['regtest-test-miner/1.0']);
            assert.equal(subscribed.error, null);
            const authorized = await client.request('mining.authorize', [`${regtest.minerAddress}.compat`, 'x']);
            assert.equal(authorized.result, true);
            const notify = await client.waitFor((m) => m.method === 'mining.notify', 5000, 'mining.notify after optional requests');
            assert.equal(notify.params.length, 9);
            client.close();
        });
    });

    describe('per-address connection limit on a separate pool process', () => {
        const LIMITED_PORT = 3336;
        let limited;

        before(async () => {
            limited = startPoolProcess({ ...regtest.poolEnv, STRATUM_PORT: String(LIMITED_PORT), MAX_CONNECTIONS_PER_IP: '3' });
            await limited.waitForLog(/Stratum Pool Server Started/, 30000);
        });

        after(async () => {
            if (limited) await limited.stop();
        });

        it('closes connections beyond the per-address limit and logs the rejection', async () => {
            const held = [];
            for (let i = 0; i < 3; i++) held.push(await StratumClient.connect(LIMITED_PORT));
            const rejected = await StratumClient.connect(LIMITED_PORT);
            await rejected.waitForClose();
            await limited.waitForLog(/Rejected \d+ connection\(s\).*per address/, 5000);

            held[0].close();
            await held[0].waitForClose();
            // the pool learns of the close a moment after the client does, so the slot frees asynchronously
            const { client: replacement, reply } = await regtest.waitUntil(async () => {
                const candidate = await StratumClient.connect(LIMITED_PORT);
                const answer = await candidate.request('mining.subscribe', ['regtest-test-miner/1.0'], 500).catch(() => null);
                if (answer) return { client: candidate, reply: answer };
                candidate.close();
                return null;
            }, 'the freed connection slot to accept a new connection', 5000);
            assert.equal(reply.error, null);
            [replacement, ...held.slice(1)].forEach((client) => client.close());
        });
    });

    describe('protocol limits on a separate pool process', () => {
        const LIMITED_PORT = 3334;
        let limited;

        before(async () => {
            limited = startPoolProcess({
                ...regtest.poolEnv,
                STRATUM_PORT: String(LIMITED_PORT),
                MAX_CONNECTIONS_PER_IP: '50',
                MAX_PROTOCOL_ERRORS: '4',
                HANDSHAKE_TIMEOUT_SECONDS: '2',
                MESSAGE_RATE_LIMIT: '60',
                MESSAGE_RATE_WINDOW_SECONDS: '10'
            });
            await limited.waitForLog(/Stratum Pool Server Started/, 30000);
        });

        after(async () => {
            if (limited) await limited.stop();
        });

        it('disconnects clients that repeatedly send submissions without authorizing', async () => {
            const client = await StratumClient.connect(LIMITED_PORT);
            const submission = ['rig', 'job', '00000001', '5f000000', '00000001'];
            for (let i = 0; i < 6; i++) client.sendRaw(JSON.stringify({ id: i + 1, method: 'mining.submit', params: submission }) + '\n');
            await client.waitForClose();
            await limited.waitForLog(/after 4 protocol errors/, 5000);
        });

        it('disconnects clients that never complete the handshake', async () => {
            const client = await StratumClient.connect(LIMITED_PORT);
            await client.waitForClose(8000);
            await limited.waitForLog(/not completing subscribe and authorize/, 5000);
        });

        it('keeps log lines short however much text a client sends', async () => {
            const mark = limited.lines.length;
            const garbage = await StratumClient.connect(LIMITED_PORT);
            garbage.sendRaw(`${'x'.repeat(8000)}\n`);
            await garbage.waitForClose();

            const abusive = await StratumClient.connect(LIMITED_PORT);
            const login = `${'y'.repeat(8000)}`;
            for (let i = 0; i < 3; i++) await abusive.request('mining.authorize', [login, 'x']);
            abusive.sendRaw(`${JSON.stringify({ id: 99, method: 'mining.authorize', params: [login, 'x'] })}\n`);
            await abusive.waitForClose();

            const logged = await Promise.all([/Malformed message/, /protocol errors/, /Rejected worker login/]
                .map((pattern) => limited.waitForLog(pattern, 5000, mark)));
            for (const line of logged) assert.ok(line.length < 300, `log line of ${line.length} characters`);
        });

        it('disconnects a client flooding optional requests while a busy miner on the same pool is unaffected', async () => {
            const mark = limited.lines.length;
            const busy = await connectMiner(`${regtest.minerAddress}.busy`, { port: LIMITED_PORT });
            const flooder = await StratumClient.connect(LIMITED_PORT);
            for (let i = 1; i <= 100; i++) flooder.sendRaw(`${JSON.stringify({ id: i, method: 'mining.configure', params: [['version-rolling'], {}] })}\n`);
            await flooder.waitForClose();
            await limited.waitForLog(/for sending more than 60 messages in 10 seconds/, 5000, mark);

            for (let i = 0; i < 20; i++) {
                const reply = await busy.client.request('mining.submit', [busy.login, 'no-such-job', '00000000', '5f000000', '00000001']);
                assert.equal(reply.error[0], 21);
            }
            busy.client.close();
        });

        it('keeps serving authorized miners on the default pool', async () => {
            const healthy = await connectMiner(`${regtest.minerAddress}.limits`);
            assert.equal(healthy.authorized.result, true);
            healthy.client.close();
        });
    });

    describe('output backpressure on a separate pool process', () => {
        const STALL_PORT = 3335;
        let stall;

        before(async () => {
            stall = startPoolProcess({
                ...regtest.poolEnv,
                STRATUM_PORT: String(STALL_PORT),
                MESSAGE_RATE_LIMIT: '0',
                MAX_OUTPUT_BUFFER_BYTES: '65536'
            });
            await stall.waitForLog(/Stratum Pool Server Started/, 30000);
        });

        after(async () => {
            if (stall) await stall.stop();
        });

        it('disconnects a client that never reads and keeps serving others', async () => {
            const mark = stall.lines.length;
            const stalled = await StratumClient.connect(STALL_PORT);
            stalled.socket.pause();
            const names = JSON.stringify([Array.from({ length: 500 }, (_, i) => `ext-${i}`.padEnd(8, 'x'))]);
            const request = `{"id":1,"method":"mining.configure","params":${names}}\n`;
            const deadline = Date.now() + 25000;
            let logged = null;
            const loggedPromise = stall.waitForLog(/bytes of unread output/, 25000, mark).then((line) => { logged = line; }, () => {});
            while (!logged && Date.now() < deadline) {
                if (stalled.socket.writableLength > 1 << 20) await new Promise((resolve) => { stalled.socket.once('drain', resolve); setTimeout(resolve, 200); });
                if (stalled.socket.destroyed) break;
                stalled.socket.write(request);
                await new Promise((resolve) => setImmediate(resolve));
            }
            await loggedPromise;
            assert.ok(logged, 'pool never disconnected the client that does not read');
            assert.ok(logged.length < 300);
            stalled.socket.destroy();

            const healthy = await connectMiner(`${regtest.minerAddress}.reader`, { port: STALL_PORT });
            assert.equal(healthy.authorized.result, true);
            healthy.client.close();
        });
    });
});
