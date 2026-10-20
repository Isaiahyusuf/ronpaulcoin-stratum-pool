const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRegtestEnvironment } = require('../helpers/regtestEnv');
const { proofOfWork, targetFromBits, sha256d, reverse } = require('../helpers/testMiner');

const regtest = createRegtestEnvironment({ stratumPort: 3333, difficulty: 0.000025 });
const { rpcA } = regtest;
const NONCE_OFFSET = 76;

// Re-mines the tip block on top of a different parent so it has valid proof of work but an unknown parent.
async function mineWithParent(tipHash, parentHash) {
    const block = Buffer.from(await rpcA('getblock', [tipHash, false]), 'hex');
    const target = targetFromBits((await rpcA('getblock', [tipHash])).bits);
    Buffer.from(parentHash, 'hex').reverse().copy(block, 4);
    for (let nonce = 0; nonce < 5_000_000; nonce++) {
        block.writeUInt32LE(nonce, NONCE_OFFSET);
        if (proofOfWork(block.subarray(0, 80)) <= target) return block;
    }
    throw new Error('no nonce found');
}

const blockHash = (block) => reverse(sha256d(block.subarray(0, 80))).toString('hex');

const notFound = async (hash) => {
    await assert.rejects(() => rpcA('getblock', [hash]), (error) => error.code === -5 && /Block not found/.test(error.message));
};

describe('pinned daemon submitblock responses', () => {
    it('acknowledges a block with an unknown parent with null and does not index or keep it', async () => {
        const tip = await rpcA('getbestblockhash');
        const orphan = await mineWithParent(tip, crypto.createHash('sha256').update('unknown parent').digest('hex'));
        const hash = blockHash(orphan);

        assert.notEqual(hash, tip);
        assert.equal(await rpcA('submitblock', [orphan.toString('hex')]), null);
        await notFound(hash);
        assert.equal(await rpcA('submitblock', [orphan.toString('hex')]), null);
        await notFound(hash);
        assert.equal(await rpcA('getbestblockhash'), tip);
    });

    it('answers rejected for a duplicate of an indexed block', async () => {
        const tip = await rpcA('getbestblockhash');
        const hex = await rpcA('getblock', [tip, false]);
        assert.equal(await rpcA('submitblock', [hex]), 'rejected');
        assert.equal((await rpcA('getblock', [tip])).confirmations > 0, true);
    });

    it('answers rejected for a block that fails proof of work and does not index it', async () => {
        const tip = await rpcA('getbestblockhash');
        const target = targetFromBits((await rpcA('getblock', [tip])).bits);
        const block = Buffer.from(await rpcA('getblock', [tip, false]), 'hex');
        Buffer.alloc(32, 1).copy(block, 4);
        let nonce = 0;
        do { block.writeUInt32LE(nonce++, NONCE_OFFSET); } while (proofOfWork(block.subarray(0, 80)) <= target);

        assert.equal(await rpcA('submitblock', [block.toString('hex')]), 'rejected');
        await notFound(blockHash(block));
        assert.equal(await rpcA('getbestblockhash'), tip);
    });

    it('answers -1 for a call that never reaches ProcessBlock, so -1 cannot prove the block was unprocessed or processed', async () => {
        const tip = await rpcA('getbestblockhash');
        await assert.rejects(() => rpcA('submitblock', []), (error) => error.code === -1);
        assert.equal(await rpcA('getbestblockhash'), tip);
    });

    it('answers -32601 for an unknown method', async () => {
        await assert.rejects(() => rpcA('nosuchmethod', []), (error) => error.code === -32601);
    });

    it('answers a JSON-RPC error and indexes nothing for an undecodable block', async () => {
        const tip = await rpcA('getbestblockhash');
        await assert.rejects(() => rpcA('submitblock', ['00']), (error) => error.code === -22);
        assert.equal(await rpcA('getbestblockhash'), tip);
    });
});
