// Test-only: connects to the pool over Stratum and mines blocks the way an external miner would.
const assert = require('node:assert/strict');
const { StratumClient } = require('./stratumClient');
const miner = require('./testMiner');

async function connectWorker(port, login) {
    const client = await StratumClient.connect(port);
    const subscribed = await client.request('mining.subscribe', ['regtest-test-miner/1.0']);
    assert.equal(subscribed.error, null);
    const authorized = await client.request('mining.authorize', [login, 'x']);
    assert.deepEqual([authorized.result, authorized.error], [true, null]);
    const [, extraNonce1, extraNonce2Size] = subscribed.result;
    return { client, login, extraNonce1, extraNonce2Size };
}

const buildsOn = (params, tipHash) =>
    miner.swapWords(Buffer.from(params[1], 'hex')).equals(miner.reverse(Buffer.from(tipHash, 'hex')));

function nextJob(worker, tipHash, { accept = () => true, timeoutMs = 20000 } = {}) {
    return worker.client.waitFor(
        (message) => message.method === 'mining.notify' && buildsOn(message.params, tipHash) && accept(message.params),
        timeoutMs,
        `a job built on ${tipHash}`
    );
}

async function solveJob(worker, params, extraNonce2 = '00000001') {
    const candidate = miner.buildCandidate(params, worker.extraNonce1, extraNonce2);
    const target = miner.targetFromBits(params[6]);
    const solution = miner.findNonce(candidate, (pow) => pow <= target);
    const response = await worker.client.request(
        'mining.submit',
        [worker.login, params[0], extraNonce2, params[7], miner.nonceHex(solution.nonce)]
    );
    return {
        response,
        candidate,
        header: solution.header,
        hash: miner.reverse(miner.sha256d(solution.header)).toString('hex')
    };
}

module.exports = { connectWorker, nextJob, solveJob };
