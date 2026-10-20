const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createRegtestEnvironment } = require('../helpers/regtestEnv');
const { startPoolProcess } = require('../helpers/poolProcess');
const { connectWorker, nextJob, solveJob } = require('../helpers/poolMiner');
const { buildSignedTransaction } = require('../helpers/transactions');
const miner = require('../helpers/testMiner');

const COIN = 100000000n;
const HALVING_INTERVAL = 150;
const COINBASE_MATURITY = 100;
const BLOCKS_TO_MINE = 160;
const FEE = 100000n;

const regtest = createRegtestEnvironment({ stratumPort: 3333, difficulty: 0.000025 });
const { rpcA, rpcB } = regtest;
const subsidyAt = (height) => COIN >> BigInt(Math.floor(height / HALVING_INTERVAL));

describe('consecutive blocks mined through the pool on two regtest nodes', () => {
    let pool;
    let worker;
    const mined = new Map();
    let tipHeight;
    let tipHash;

    const mineThroughPool = async (accept) => {
        const job = await nextJob(worker, tipHash, { accept });
        const solved = await solveJob(worker, job.params);
        assert.deepEqual([solved.response.result, solved.response.error], [true, null]);
        const height = tipHeight + 1;
        await regtest.waitUntil(async () => (await rpcA('getblockcount')) === height, `node A at height ${height}`);
        await regtest.waitUntil(async () => (await rpcB('getblockcount')) === height, `node B at height ${height}`);
        assert.equal(await rpcA('getbestblockhash'), solved.hash);
        assert.equal(await rpcB('getbestblockhash'), solved.hash);
        tipHeight = height;
        tipHash = solved.hash;
        mined.set(height, { ...solved, params: job.params });
        return { ...solved, params: job.params, height };
    };

    const coinbaseOf = async (hash) => {
        const raw = Buffer.from(await rpcB('getblock', [hash, false]), 'hex');
        const countByte = raw[80];
        assert.ok(countByte < 0xfd);
        const body = raw.subarray(81);
        const coinbase = miner.parseTransaction(body);
        const txid = miner.sha256d(body.subarray(0, body.length - coinbase.trailingBytes));
        return { header: raw.subarray(0, 80), transactionCount: countByte, coinbase, txid, id: miner.reverse(txid).toString('hex') };
    };

    before(async () => {
        pool = startPoolProcess({ ...regtest.poolEnv, JOB_REBROADCAST_SECONDS: '3' });
        await pool.waitForLog(/Stratum Pool Server Started/, 30000);
        worker = await connectWorker(regtest.stratumPort, `${regtest.minerAddress}.chain`);
        tipHeight = await rpcA('getblockcount');
        tipHash = await rpcA('getbestblockhash');
    });

    after(async () => {
        if (worker) worker.client.close();
        if (pool) await pool.stop();
    });

    it(`mines ${BLOCKS_TO_MINE} blocks in a row and both nodes accept each one`, async () => {
        const startHeight = tipHeight;
        for (let i = 0; i < BLOCKS_TO_MINE; i++) {
            const previousHash = tipHash;
            const block = await mineThroughPool();
            const stored = await coinbaseOf(block.hash);

            assert.ok(stored.header.equals(block.header), `block ${block.height} header differs from what the miner built`);
            assert.equal(miner.reverse(stored.header.subarray(4, 36)).toString('hex'), previousHash);
            assert.equal(stored.transactionCount, 1);

            const [input] = stored.coinbase.inputs;
            const push = miner.heightPush(block.height);
            assert.ok(input.scriptSig.subarray(0, push.length).equals(push), `block ${block.height} has the wrong height push`);
            assert.equal(stored.coinbase.outputs.length, 1);
            assert.equal(stored.coinbase.outputs[0].value, subsidyAt(block.height), `block ${block.height} reward`);
            assert.ok(miner.p2pkhHash160(stored.coinbase.outputs[0].script).equals(regtest.poolHash160));
        }
        assert.equal(tipHeight, startHeight + BLOCKS_TO_MINE);
        assert.ok(startHeight < HALVING_INTERVAL && tipHeight >= HALVING_INTERVAL, 'the run must cross the halving height');
        assert.equal(await rpcA('getblockcount'), tipHeight);
        assert.equal(await rpcB('getblockcount'), tipHeight);
        console.log(`      chain height reached: ${tipHeight} (started at ${startHeight})`);
    });

    describe('coinbase maturity and transactions', () => {
        const key = regtest.poolKey;
        const spendCoinbase = async (height, { fee = FEE } = {}) => {
            const block = await coinbaseOf(mined.get(height).hash);
            const value = block.coinbase.outputs[0].value;
            return buildSignedTransaction(key, [{ txid: block.txid, index: 0 }], [{ value: value - fee, script: key.script }]);
        };
        let tip;
        let matureSpend;

        before(() => {
            tip = tipHeight;
        });

        it('the pool coinbase output is a flagged, unspent coinbase output in the UTXO set', async () => {
            const block = await coinbaseOf(mined.get(tip - 99).hash);
            const output = await rpcA('gettxout', [block.id, 0]);
            assert.equal(output.coinbase, true);
            assert.equal(output.value, Number(subsidyAt(tip - 99)) / 1e8);
        });

        it('rejects spending coinbases younger than 100 blocks and accepts the first mature one', async () => {
            for (const height of [tip, tip - 50, tip - 98]) {
                const spend = await spendCoinbase(height);
                await assert.rejects(rpcA('sendrawtransaction', [spend.hex]), { code: -22 }, `coinbase at depth ${tip - height + 1}`);
            }
            matureSpend = await spendCoinbase(tip - 99);
            assert.equal(await rpcA('sendrawtransaction', [matureSpend.hex]), matureSpend.id);
            await regtest.waitUntil(async () => (await rpcB('getrawmempool')).includes(matureSpend.id), 'node B to relay the transaction');
        });

        it('builds a block from a template with chained and independent transactions', async () => {
            const first = matureSpend;
            const child = buildSignedTransaction(key, [{ txid: first.txid, index: 0 }], [{ value: subsidyAt(tip - 99) - 2n * FEE, script: key.script }]);
            const independent = await spendCoinbase(tip - 100);
            for (const spend of [child, independent]) await rpcA('sendrawtransaction', [spend.hex]);
            await regtest.waitUntil(async () => (await rpcA('getrawmempool')).length === 3, 'three mempool transactions');

            // the daemon serves a cached template for up to 5 seconds after the mempool changes
            const template = await regtest.waitUntil(async () => {
                const candidate = await rpcA('getblocktemplate');
                return candidate.transactions.length === 3 && candidate;
            }, 'a template containing the mempool transactions', 20000);
            const templateIds = template.transactions.map((tx) => tx.hash);
            assert.deepEqual([...templateIds].sort(), [first.id, child.id, independent.id].sort());
            assert.ok(templateIds.indexOf(first.id) < templateIds.indexOf(child.id), 'parent must precede its child');
            const totalFees = 3n * FEE;
            assert.equal(BigInt(template.coinbasevalue), subsidyAt(tip + 1) + totalFees);

            const job = await nextJob(worker, tipHash, { accept: (params) => params[4].length === 2 });
            const solved = await solveJob(worker, job.params);
            assert.deepEqual([solved.response.result, solved.response.error], [true, null]);

            const height = tip + 1;
            await regtest.waitUntil(async () => (await rpcA('getblockcount')) === height, 'node A to accept the block');
            await regtest.waitUntil(async () => (await rpcB('getblockcount')) === height, 'node B to accept the block');
            assert.equal(await rpcA('getbestblockhash'), solved.hash);
            assert.equal(await rpcB('getbestblockhash'), solved.hash);
            tipHeight = height;
            tipHash = solved.hash;

            const coinbaseId = miner.reverse(solved.candidate.coinbaseTxid).toString('hex');
            const expectedOrder = [coinbaseId, ...templateIds];
            for (const rpc of [rpcA, rpcB]) {
                const block = await rpc('getblock', [solved.hash]);
                assert.deepEqual(block.tx, expectedOrder);
                assert.equal(block.merkleroot, miner.reverse(
                    miner.merkleRootFromList(expectedOrder.map((id) => miner.reverse(Buffer.from(id, 'hex'))))
                ).toString('hex'));
            }
            assert.ok(solved.candidate.merkleRoot.equals(
                miner.merkleRootFromList(expectedOrder.map((id) => miner.reverse(Buffer.from(id, 'hex'))))
            ));

            const stored = await coinbaseOf(solved.hash);
            assert.equal(stored.transactionCount, 4);
            assert.equal(stored.coinbase.outputs.length, 1);
            assert.equal(stored.coinbase.outputs[0].value, subsidyAt(height) + totalFees);
            assert.deepEqual(await rpcA('getrawmempool'), []);
            assert.deepEqual(await rpcB('getrawmempool'), []);
        });

        it('treats the coinbase at depth 100 as spendable once the next block arrives', async () => {
            const spend = await spendCoinbase(tip - 98);
            assert.equal(await rpcA('sendrawtransaction', [spend.hex]), spend.id);

            const job = await nextJob(worker, tipHash, { accept: (params) => params[4].length === 1 });
            const solved = await solveJob(worker, job.params);
            assert.deepEqual([solved.response.result, solved.response.error], [true, null]);
            const height = tipHeight + 1;
            await regtest.waitUntil(async () => (await rpcB('getblockcount')) === height, 'node B to accept the block');
            const block = await rpcB('getblock', [solved.hash]);
            assert.deepEqual(block.tx, [miner.reverse(solved.candidate.coinbaseTxid).toString('hex'), spend.id]);
            tipHeight = height;
            tipHash = solved.hash;
            console.log(`      final chain height: ${tipHeight}`);
        });
    });
});
