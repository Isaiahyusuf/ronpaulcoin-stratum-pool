const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const stratum = require('../vendor/stratum-pool/lib');
const coin = require('../coins/ronpaulcoin.json');
const { encodeAddress } = require('../lib/address');

const POOL_ADDRESS = encodeAddress(122, Buffer.alloc(20, 7));
const BLOCK_HASH = 'ab'.repeat(32);
const BLOCK_HEX = 'cd'.repeat(150);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Scripted daemon fixtures: they answer pool startup, then follow per-test behaviour for submitblock/getblock.
describe('block submission against failing daemons', () => {
    let fixtures;
    let pool;
    let logs;
    let shares;

    const startupAnswer = (method) => ({
        validateaddress: { isvalid: true, address: POOL_ADDRESS },
        getdifficulty: 1,
        getmininginfo: { networkhashps: 0 },
        getinfo: { testnet: true, protocolversion: 70002, difficulty: 1, connections: 1 },
        getpeerinfo: [],
        submitblock: null
    }[method]);

    const createFixture = async () => {
        const fixture = { submits: 0, getblocks: 0, submitBehaviour: null, getblockBehaviour: null };
        fixture.server = http.createServer((request, response) => {
            let body = '';
            request.on('data', (chunk) => { body += chunk; });
            request.on('end', () => {
                const payload = JSON.parse(body);
                const reply = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
                if (Array.isArray(payload)) {
                    return reply(200, payload.map(({ method }) => (method === 'submitblock'
                        ? { result: null, error: { code: -1, message: 'bad params' } }
                        : { result: startupAnswer(method), error: null })));
                }
                if (payload.method === 'submitblock' && fixture.submitBehaviour) {
                    fixture.submits++;
                    return fixture.submitBehaviour(fixture.submits, request, reply);
                }
                if (payload.method === 'getblock' && fixture.getblockBehaviour) {
                    fixture.getblocks++;
                    return fixture.getblockBehaviour(request, reply);
                }
                if (payload.method === 'getblocktemplate') return reply(200, { result: null, error: { code: -9, message: 'no template in fixture' } });
                return reply(200, { result: startupAnswer(payload.method) ?? null, error: null });
            });
        });
        await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
        fixture.port = fixture.server.address().port;
        return fixture;
    };

    const startPool = async (daemonCount, overrides = {}) => {
        fixtures = await Promise.all(Array.from({ length: daemonCount }, createFixture));
        logs = [];
        shares = [];
        pool = stratum.createPool({
            coin,
            address: POOL_ADDRESS,
            daemons: fixtures.map((f) => ({ host: '127.0.0.1', port: f.port, user: 'u', password: 'pool-test-password', timeoutMs: 400 })),
            ports: { 0: { diff: 1 } },
            blockRefreshInterval: 1000,
            jobRebroadcastTimeout: 55,
            connectionTimeout: 600,
            tcpProxyProtocol: false,
            banning: { enabled: false },
            p2p: { enabled: false },
            blockSubmitAttempts: 3,
            blockSubmitRetryMs: 30,
            blockReconcileAttempts: 3,
            blockReconcileRetryMs: 30,
            ...overrides
        }, (port, workerName, password, callback) => callback({ error: null, authorized: true, disconnect: false }));
        pool.on('log', (severity, message) => logs.push(`${severity}: ${message}`));
        pool.on('share', (isValidShare, isValidBlock, data) => shares.push({ isValidBlock, data }));
        pool.start();
        await waitFor(() => logs.some((line) => /Error with getblocktemplate on creating first job/.test(line)));
    };

    const waitFor = async (predicate, timeoutMs = 4000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error(`condition not met; logs:\n${logs.join('\n')}`);
            await delay(20);
        }
    };

    const submitFoundBlock = () => pool.jobManager.emit('share', { blockHash: BLOCK_HASH, worker: 'w' }, BLOCK_HEX);
    const logged = (pattern) => logs.filter((line) => pattern.test(line));
    const acceptBlock = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: 1 }, error: null });
    const unknownBlock = (request, reply) => reply(200, { result: null, error: { code: -5, message: 'Block not found' } });
    const unauthorized = (submits, request, reply) => reply(401, 'Unauthorized');

    beforeEach(() => { fixtures = []; });

    afterEach(async () => {
        await Promise.all(fixtures.map((f) => new Promise((resolve) => { f.server.closeAllConnections(); f.server.close(resolve); })));
    });

    it('does not retry an authentication error and logs the block for manual submission', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = unauthorized;
        fixtures[0].getblockBehaviour = unknownBlock;
        submitFoundBlock();
        await waitFor(() => shares.length === 1);
        await delay(200);

        assert.equal(fixtures[0].submits, 1);
        assert.equal(shares[0].isValidBlock, false);
        assert.equal(logged(new RegExp(`could not be submitted after 1 attempt because .*permanent RPC error.*submitblock: ${BLOCK_HEX}`)).length, 1);
        assert.equal(logged(new RegExp(`Block ${BLOCK_HASH} is UNRESOLVED \\(no daemon processed the block.*submitblock: ${BLOCK_HEX}`)).length, 1);
        assert.equal(shares[0].data.blockStatus, 'unresolved');
        assert.doesNotMatch(logs.join('\n'), /pool-test-password/);
    });

    it('does not retry a malformed response and still verifies the block with getblock', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request, reply) => reply(200, 'not json');
        fixtures[0].getblockBehaviour = acceptBlock;
        submitFoundBlock();
        await waitFor(() => shares.length === 1);
        await delay(200);

        assert.equal(fixtures[0].submits, 1);
        assert.equal(shares[0].isValidBlock, true);
        assert.equal(logged(new RegExp(`submitblock: ${BLOCK_HEX}`)).length, 1);
    });

    it('retries connection resets and reports the block once a submission succeeds', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request, reply) => (submits < 3 ? request.socket.destroy() : reply(200, { result: null, error: null }));
        fixtures[0].getblockBehaviour = (request, reply) => (fixtures[0].submits >= 3 ? acceptBlock(request, reply) : unknownBlock(request, reply));
        submitFoundBlock();
        await waitFor(() => shares.length === 1);
        await delay(200);

        assert.equal(fixtures[0].submits, 3);
        assert.equal(shares.length, 1);
        assert.equal(shares[0].isValidBlock, true);
        assert.equal(logged(/could not be submitted/).length, 0);
    });

    it('stops after the configured attempts on network failure and keeps the manual recovery hex', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request) => request.socket.destroy();
        fixtures[0].getblockBehaviour = unknownBlock;
        submitFoundBlock();
        await waitFor(() => shares.length === 1);
        await delay(200);

        assert.equal(fixtures[0].submits, 3);
        assert.equal(fixtures[0].getblocks, 5);
        assert.equal(logged(new RegExp(`could not be submitted after 3 attempts because .*submitblock: ${BLOCK_HEX}`)).length, 1);
        assert.equal(logged(/permanent RPC error/).length, 0);
        assert.equal(shares[0].isValidBlock, false);
        assert.equal(shares[0].data.blockStatus, 'unresolved');
        assert.match(shares[0].data.blockStatusReason, /may have been processed/);
    });

    it('terminates a hung submitblock at the timeout and retries it', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request, reply) => { if (submits === 2) reply(200, { result: null, error: null }); };
        fixtures[0].getblockBehaviour = (request, reply) => (fixtures[0].submits >= 2 ? acceptBlock(request, reply) : unknownBlock(request, reply));
        const started = Date.now();
        submitFoundBlock();
        await waitFor(() => shares.length === 1);

        assert.equal(fixtures[0].submits, 2);
        assert.ok(Date.now() - started < 3000);
        assert.equal(shares[0].isValidBlock, true);
    });

    it('does not resubmit when a daemon answers, even if another rejects the duplicate', async () => {
        await startPool(2);
        fixtures[0].submitBehaviour = (submits, request, reply) => reply(200, { result: null, error: null });
        fixtures[1].submitBehaviour = (submits, request, reply) => reply(200, { result: 'rejected', error: null });
        fixtures.forEach((f) => { f.getblockBehaviour = acceptBlock; });
        submitFoundBlock();
        await waitFor(() => shares.length === 1);
        await delay(200);

        assert.deepEqual(fixtures.map((f) => f.submits), [1, 1]);
        assert.equal(shares[0].isValidBlock, true);
        assert.equal(logged(/answered "rejected" for the block/).length, 1);
        assert.equal(logged(/could not be submitted/).length, 0);
    });

    it('retries while the only daemon that could take the block is unreachable and the other has bad credentials', async () => {
        await startPool(2);
        fixtures[0].submitBehaviour = unauthorized;
        fixtures[1].submitBehaviour = (submits, request) => request.socket.destroy();
        fixtures.forEach((f) => { f.getblockBehaviour = unknownBlock; });
        submitFoundBlock();
        await waitFor(() => shares.length === 1);
        await delay(200);

        assert.equal(fixtures[1].submits, 3);
        assert.equal(fixtures[0].submits, 3);
        assert.equal(logged(new RegExp(`could not be submitted after 3 attempts .*submitblock: ${BLOCK_HEX}`)).length, 1);
    });

    it('does not report a block as accepted when a daemon only holds it on a side chain', async () => {
        await startPool(2);
        fixtures.forEach((f) => { f.submitBehaviour = (submits, request, reply) => reply(200, { result: null, error: null }); });
        fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: 0 }, error: null });
        fixtures[1].getblockBehaviour = unknownBlock;
        submitFoundBlock();
        await waitFor(() => shares.length === 1);

        assert.equal(shares[0].isValidBlock, false);
        assert.equal(shares[0].data.blockStatus, 'side chain');
        assert.equal(logged(/indexed only on a side chain/).length, 1);
    });

    it('does not report a block as accepted when getblock omits confirmations', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request, reply) => reply(200, { result: null, error: null });
        fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'] }, error: null });
        submitFoundBlock();
        await waitFor(() => shares.length === 1);

        assert.equal(shares[0].isValidBlock, false);
    });

    it('does not report a block as accepted when confirmations is negative', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request, reply) => reply(200, { result: null, error: null });
        fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: -1 }, error: null });
        submitFoundBlock();
        await waitFor(() => shares.length === 1);

        assert.equal(shares[0].isValidBlock, false);
    });

    it('reports a block as accepted when any daemon has it on the main chain', async () => {
        await startPool(2);
        fixtures.forEach((f) => { f.submitBehaviour = (submits, request, reply) => reply(200, { result: null, error: null }); });
        fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: 0 }, error: null });
        fixtures[1].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: 1 }, error: null });
        submitFoundBlock();
        await waitFor(() => shares.length === 1);

        assert.equal(shares[0].isValidBlock, true);
    });

    it('emits the share exactly once per found block', async () => {
        await startPool(1);
        fixtures[0].submitBehaviour = (submits, request, reply) => reply(200, { result: null, error: null });
        fixtures[0].getblockBehaviour = acceptBlock;
        submitFoundBlock();
        await waitFor(() => shares.length >= 1);
        await delay(300);

        assert.equal(shares.length, 1);
        assert.equal(fixtures[0].getblocks, 1);
    });

    describe('ambiguous submission outcomes', () => {
        const ack = (submits, request, reply) => reply(200, { result: null, error: null });
        const refuse = (submits, request, reply) => reply(200, { result: 'rejected', error: null });
        const chainState = (fixture) => (request, reply) => (fixture.accepted ? acceptBlock(request, reply) : unknownBlock(request, reply));
        const resolved = async (count = 1) => { await waitFor(() => shares.length === count); await delay(150); };

        it('resolves a lost submitblock response with getblock instead of resubmitting', async () => {
            await startPool(1);
            const fixture = fixtures[0];
            fixture.submitBehaviour = (submits, request) => { fixture.accepted = true; request.socket.destroy(); };
            fixture.getblockBehaviour = chainState(fixture);
            submitFoundBlock();
            await resolved();

            assert.equal(fixture.submits, 1);
            assert.equal(shares.length, 1);
            assert.equal(shares[0].isValidBlock, true);
            assert.equal(shares[0].data.blockStatus, 'accepted');
            assert.equal(shares[0].data.txHash, 'txid');
            assert.equal(logged(/already known to a daemon \(main chain\), not resubmitting/).length, 1);
            assert.equal(logged(/could not be submitted|answered "rejected"|UNRESOLVED/).length, 0);
        });

        it('detects a block that a stalled daemon processed after the pool stopped retrying', async () => {
            await startPool(1);
            const fixture = fixtures[0];
            fixture.submitBehaviour = () => {};
            fixture.getblockBehaviour = (request, reply) => {
                if (fixture.getblocks === 4) fixture.accepted = true;
                chainState(fixture)(request, reply);
            };
            submitFoundBlock();
            await waitFor(() => shares.length === 1, 8000);

            assert.equal(fixture.submits, 3);
            assert.equal(fixture.getblocks, 4);
            assert.equal(logged(new RegExp(`could not be submitted after 3 attempts .*submitblock: ${BLOCK_HEX}`)).length, 1);
            assert.equal(shares[0].isValidBlock, true);
            assert.equal(shares[0].data.blockStatus, 'accepted');
        });

        it('keeps an acknowledged block that is absent from the index unresolved after polling the whole window', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = ack;
            fixtures[0].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(fixtures[0].submits, 1);
            assert.equal(fixtures[0].getblocks, 3);
            assert.equal(shares[0].isValidBlock, false);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /discarded orphan/);
            assert.equal(logged(new RegExp(`Block ${BLOCK_HASH} is UNRESOLVED .*discarded orphan.*submitblock: ${BLOCK_HEX}`)).length, 1);
            assert.equal(logged(/was rejected/).length, 0);
        });

        it('accepts an acknowledged block that appears in the index after a delay', async () => {
            await startPool(1);
            const fixture = fixtures[0];
            fixture.submitBehaviour = ack;
            fixture.getblockBehaviour = (request, reply) => (fixture.getblocks >= 3 ? acceptBlock(request, reply) : unknownBlock(request, reply));
            submitFoundBlock();
            await resolved();

            assert.equal(fixture.getblocks, 3);
            assert.equal(shares[0].isValidBlock, true);
            assert.equal(shares[0].data.blockStatus, 'accepted');
            assert.equal(logged(/UNRESOLVED/).length, 0);
        });

        it('never reports a block as definitively rejected: "rejected" plus "Block not found" everywhere stays unresolved', async () => {
            await startPool(2);
            fixtures.forEach((f) => { f.submitBehaviour = refuse; f.getblockBehaviour = unknownBlock; });
            submitFoundBlock();
            await resolved();

            assert.deepEqual(fixtures.map((f) => f.getblocks), [3, 3]);
            assert.deepEqual(fixtures.map((f) => f.submits), [1, 1]);
            assert.equal(shares[0].isValidBlock, false);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /does not prove the block is invalid.*"Block not found" from 2 of 2/);
            assert.equal(shares[0].data.blockHex, BLOCK_HEX);
            assert.equal(logged(new RegExp(`Block ${BLOCK_HASH} is UNRESOLVED .*submitblock: ${BLOCK_HEX}`)).length, 1);
            assert.equal(logged(/was rejected/).length, 0);
        });

        it('treats a rejected duplicate as accepted when the block is in the index', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = refuse;
            fixtures[0].getblockBehaviour = acceptBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].isValidBlock, true);
            assert.equal(shares[0].data.blockStatus, 'accepted');
        });

        it('reports how many daemons confirmed the block is absent when one cannot answer', async () => {
            await startPool(2);
            fixtures[0].submitBehaviour = refuse;
            fixtures[0].getblockBehaviour = unknownBlock;
            fixtures[1].submitBehaviour = refuse;
            fixtures[1].getblockBehaviour = (request) => request.socket.destroy();
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /"Block not found" from 1 of 2/);
        });

        it('keeps a block unresolved as an orphan when one daemon refused it and another acknowledged it', async () => {
            await startPool(2);
            fixtures[0].submitBehaviour = refuse;
            fixtures[1].submitBehaviour = ack;
            fixtures.forEach((f) => { f.getblockBehaviour = unknownBlock; });
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /discarded orphan/);
        });

        it('keeps evidence from an earlier ambiguous attempt when a later attempt is refused', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = (submits, request, reply) => (submits === 1 ? request.socket.destroy() : refuse(submits, request, reply));
            fixtures[0].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(fixtures[0].submits, 2);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /may have been processed/);
        });

        it('keeps a block unresolved with recovery details when a daemon resets every request', async () => {
            await startPool(1);
            const fixture = fixtures[0];
            fixture.submitBehaviour = (submits, request) => request.socket.destroy();
            fixture.getblockBehaviour = (request) => request.socket.destroy();
            submitFoundBlock();
            await resolved();

            assert.equal(shares.length, 1);
            assert.equal(shares[0].isValidBlock, false);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.equal(fixture.submits, 3);
            assert.equal(fixture.getblocks, 5);
            assert.equal(logged(new RegExp(`Block ${BLOCK_HASH} is UNRESOLVED .*submitblock: ${BLOCK_HEX}`)).length, 1);
            assert.equal(logged(/was rejected/).length, 0);
        });

        it('keeps a block unresolved when the daemon stays unavailable', async () => {
            await startPool(1);
            await new Promise((resolve) => { fixtures[0].server.closeAllConnections(); fixtures[0].server.close(resolve); });
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].isValidBlock, false);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /no daemon processed the block.*from 0 of 1/);
            assert.equal(logged(new RegExp(`could not be submitted after 3 attempts .*submitblock: ${BLOCK_HEX}`)).length, 1);
            assert.equal(logged(new RegExp(`Block ${BLOCK_HASH} is UNRESOLVED .*submitblock: ${BLOCK_HEX}`)).length, 1);
        });

        it('recovers an unresolved lookup once a daemon answers getblock again', async () => {
            await startPool(1);
            const fixture = fixtures[0];
            fixture.submitBehaviour = ack;
            fixture.getblockBehaviour = (request, reply) => (fixture.getblocks < 3 ? request.socket.destroy() : acceptBlock(request, reply));
            submitFoundBlock();
            await resolved();

            assert.equal(shares.length, 1);
            assert.equal(fixture.submits, 1);
            assert.equal(fixture.getblocks, 3);
            assert.equal(shares[0].data.blockStatus, 'accepted');
            assert.equal(logged(/UNRESOLVED/).length, 0);
        });

        it('does not retry a JSON-RPC error and leaves the block unresolved with its hex', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = (submits, request, reply) => reply(500, { result: null, error: { code: -22, message: 'Block decode failed' } });
            fixtures[0].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(fixtures[0].submits, 1);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /^no daemon processed the block/);
            assert.equal(logged(new RegExp(`UNRESOLVED .*submitblock: ${BLOCK_HEX}`)).length, 1);
        });

        it('does not treat a JSON-RPC -1 error as proof the block was not processed', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = (submits, request, reply) => reply(500, { result: null, error: { code: -1, message: 'std::exception inside ProcessBlock' } });
            fixtures[0].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(fixtures[0].submits, 1);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /may have been processed/);
        });

        for (const [code, label] of [[-22, 'decode failure'], [-2, 'safe mode'], [-32601, 'method not found'], [-32700, 'parse error']]) {
            it(`treats JSON-RPC ${code} (${label}) as raised before processing and does not retry it`, async () => {
                await startPool(1);
                fixtures[0].submitBehaviour = (submits, request, reply) => reply(500, { result: null, error: { code, message: label } });
                fixtures[0].getblockBehaviour = unknownBlock;
                submitFoundBlock();
                await resolved();

                assert.equal(fixtures[0].submits, 1);
                assert.equal(shares[0].data.blockStatus, 'unresolved');
                assert.match(shares[0].data.blockStatusReason, /^no daemon processed the block/);
                assert.equal(logged(new RegExp(`could not be submitted after 1 attempt because .*permanent RPC error.*submitblock: ${BLOCK_HEX}`)).length, 1);
            });
        }

        it('does not retry any JSON-RPC error even when it is ambiguous', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = (submits, request, reply) => reply(500, { result: null, error: { code: -20, message: 'Database error' } });
            fixtures[0].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(fixtures[0].submits, 1);
            assert.equal(shares[0].data.blockStatus, 'unresolved');
        });

        it('lets a main-chain report win over a side-chain report and warns that the daemons disagree', async () => {
            await startPool(2);
            fixtures.forEach((f) => { f.submitBehaviour = ack; });
            fixtures[0].getblockBehaviour = acceptBlock;
            fixtures[1].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: -1 }, error: null });
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].isValidBlock, true);
            assert.equal(shares[0].data.blockStatus, 'accepted');
            assert.equal(logged(/Daemons do not agree about block .*main chain on 1, side chain on 1, not in the index on 0, no usable answer from 0 of 2/).length, 1);
        });

        it('accepts a block one daemon has on the main chain while the other cannot answer, and says so', async () => {
            await startPool(2);
            fixtures.forEach((f) => { f.submitBehaviour = ack; });
            fixtures[0].getblockBehaviour = (request) => request.socket.destroy();
            fixtures[1].getblockBehaviour = acceptBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].data.blockStatus, 'accepted');
            assert.equal(logged(/Daemons do not agree.*no usable answer from 1 of 2/).length, 1);
        });

        it('does not warn when every daemon has the block on the main chain', async () => {
            await startPool(2);
            fixtures.forEach((f) => { f.submitBehaviour = ack; f.getblockBehaviour = acceptBlock; });
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].data.blockStatus, 'accepted');
            assert.equal(logged(/Daemons do not agree/).length, 0);
            assert.equal(shares[0].data.blockHex, undefined);
        });

        it('reports a side-chain block when one daemon has it there and the other does not know it', async () => {
            await startPool(2);
            fixtures.forEach((f) => { f.submitBehaviour = ack; });
            fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: -1 }, error: null });
            fixtures[1].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].data.blockStatus, 'side chain');
            assert.equal(shares[0].isValidBlock, false);
            assert.equal(shares[0].data.blockHex, BLOCK_HEX);
            assert.equal(logged(/Daemons do not agree.*side chain on 1, not in the index on 1/).length, 1);
        });

        it('treats a getblock reply for a different hash or without confirmations as no usable answer', async () => {
            await startPool(2);
            fixtures.forEach((f) => { f.submitBehaviour = ack; });
            fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: 'ee'.repeat(32), tx: ['txid'], confirmations: 5 }, error: null });
            fixtures[1].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'] }, error: null });
            submitFoundBlock();
            await resolved();

            assert.equal(shares[0].data.blockStatus, 'unresolved');
            assert.match(shares[0].data.blockStatusReason, /"Block not found" from 0 of 2/);
        });

        it('delivers the share event exactly once for an unresolved block and does not look like an accepted block', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = ack;
            fixtures[0].getblockBehaviour = unknownBlock;
            submitFoundBlock();
            await resolved();
            await delay(300);

            assert.equal(shares.length, 1);
            assert.equal(shares[0].isValidBlock, false);
            assert.equal(shares[0].data.txHash, undefined);
            assert.equal(shares[0].data.blockHash, BLOCK_HASH);
            assert.equal(shares[0].data.blockHex, BLOCK_HEX);
        });

        it('classifies a side-chain block separately from an unresolved one', async () => {
            await startPool(1);
            fixtures[0].submitBehaviour = ack;
            fixtures[0].getblockBehaviour = (request, reply) => reply(200, { result: { hash: BLOCK_HASH, tx: ['txid'], confirmations: -1 }, error: null });
            submitFoundBlock();
            await waitFor(() => shares.length === 1);

            assert.equal(shares[0].data.blockStatus, 'side chain');
            assert.equal(shares[0].isValidBlock, false);
        });
    });
});
