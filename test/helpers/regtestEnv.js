const { encodeAddress } = require('../../lib/address');
const { createRpcClient } = require('./rpc');
const { createTestKey } = require('./transactions');
const crypto = require('node:crypto');

const REGTEST_P2PKH = 122;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be set (run through tools/regtest.sh)`);
    return value;
}

function createRegtestEnvironment({ stratumPort, difficulty }) {
    const hosts = requireEnv('DAEMON_HOSTS').split(',');
    const credentials = { user: requireEnv('DAEMON_RPC_USER'), password: requireEnv('DAEMON_RPC_PASSWORD') };
    const [rpcA, rpcB] = hosts.map((entry) => {
        const [host, port] = entry.split(':');
        return createRpcClient({ host, port: Number(port), ...credentials });
    });

    const poolKey = createTestKey('regtest pool key');
    const poolHash160 = poolKey.hash160;
    const poolAddress = encodeAddress(REGTEST_P2PKH, poolHash160);
    const minerAddress = poolAddress;

    const poolEnv = {
        POOL_NETWORK: 'regtest',
        POOL_ADDRESS: poolAddress,
        DAEMON_HOSTS: process.env.DAEMON_HOSTS,
        DAEMON_RPC_USER: credentials.user,
        DAEMON_RPC_PASSWORD: credentials.password,
        STRATUM_PORT: String(stratumPort),
        STRATUM_DIFFICULTY: String(difficulty),
        BLOCK_REFRESH_MS: '500',
        POOL_STATS_DB: `/tmp/ronpaulcoin-pool-stats-${process.pid}-${stratumPort}.sqlite`,
        POOL_STATS_PORT: String(stratumPort + 10000),
        POOL_STATS_TOKEN: crypto.randomBytes(32).toString('hex')
    };

    const waitUntil = async (check, description, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = await check();
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    };

    return { rpcA, rpcB, poolAddress, poolHash160, poolKey, minerAddress, poolEnv, stratumPort, difficulty, waitUntil };
}

module.exports = { createRegtestEnvironment };
