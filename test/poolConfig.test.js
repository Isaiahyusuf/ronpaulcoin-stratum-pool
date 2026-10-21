const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeAddress } = require('../lib/address');
const { loadPoolConfig } = require('../lib/poolConfig');
const { createAuthorizer, parseWorkerLogin } = require('../lib/authorize');
const coin = require('../coins/ronpaulcoin.json');

const hash160 = Buffer.alloc(20, 7);
const mainAddress = encodeAddress(60, hash160);

const validEnv = () => ({
    POOL_NETWORK: 'mainnet',
    POOL_ADDRESS: mainAddress,
    DAEMON_HOSTS: 'rpc-a:9026,rpc-b:9026',
    DAEMON_RPC_USER: 'user',
    DAEMON_RPC_PASSWORD: 'secret'
});

test('loads a valid configuration with defaults', () => {
    const config = loadPoolConfig(validEnv());
    assert.equal(config.stratum.port, 3333);
    assert.equal(config.stratum.difficulty, 1);
    assert.equal(config.blockRefreshMs, 1000);
    assert.equal(config.failClosedOnTemplateFailure, true);
    assert.deepEqual(config.daemons.map((d) => [d.host, d.port]), [['rpc-a', 9026], ['rpc-b', 9026]]);
    assert.equal(config.daemons[0].password, 'secret');
});

test('fails closed by default when all daemons stop providing block templates', () => {
    assert.equal(loadPoolConfig({ ...validEnv(), POOL_FAIL_CLOSED_ON_TEMPLATE_FAILURE: 'false' }).failClosedOnTemplateFailure, false);
    assert.throws(() => loadPoolConfig({ ...validEnv(), POOL_FAIL_CLOSED_ON_TEMPLATE_FAILURE: 'yes' }), /POOL_FAIL_CLOSED_ON_TEMPLATE_FAILURE/);
});

test('does not mutate the shared coin definition', () => {
    const config = loadPoolConfig(validEnv());
    config.coin.reward = 'POW';
    assert.equal(coin.reward, undefined);
});

test('reports every configuration problem at once', () => {
    assert.throws(() => loadPoolConfig({}), (error) => {
        for (const name of ['POOL_NETWORK', 'POOL_ADDRESS', 'DAEMON_HOSTS', 'DAEMON_RPC_USER', 'DAEMON_RPC_PASSWORD']) {
            assert.match(error.message, new RegExp(name));
        }
        return true;
    });
});

test('rejects an address from another network or with a bad checksum', () => {
    assert.throws(() => loadPoolConfig({ ...validEnv(), POOL_NETWORK: 'testnet' }), /POOL_ADDRESS is not a valid testnet/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), POOL_ADDRESS: mainAddress.slice(0, -1) + '1' }), /not a valid mainnet/);
});

test('rejects a pay-to-script-hash pool address', () => {
    const env = { ...validEnv(), POOL_ADDRESS: encodeAddress(3, hash160) };
    assert.throws(() => loadPoolConfig(env), /pay-to-pubkey-hash/);
});

test('rejects malformed hosts, ports and numeric settings', () => {
    assert.throws(() => loadPoolConfig({ ...validEnv(), DAEMON_HOSTS: 'rpc-a' }), /host:port/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), DAEMON_HOSTS: 'rpc-a:70000' }), /host:port/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), STRATUM_PORT: '33.5' }), /STRATUM_PORT/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), STRATUM_DIFFICULTY: '0' }), /STRATUM_DIFFICULTY/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), BLOCK_REFRESH_MS: '5' }), /BLOCK_REFRESH_MS/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), JOB_REBROADCAST_SECONDS: '0' }), /JOB_REBROADCAST_SECONDS/);
});

test('job rebroadcast interval defaults to 55 seconds and can be overridden', () => {
    assert.equal(loadPoolConfig(validEnv()).jobRebroadcastSeconds, 55);
    assert.equal(loadPoolConfig(validEnv()).blockSubmitAttempts, 20);
    assert.equal(loadPoolConfig({ ...validEnv(), BLOCK_SUBMIT_ATTEMPTS: '3', BLOCK_SUBMIT_RETRY_MS: '500' }).blockSubmitRetryMs, 500);
    assert.throws(() => loadPoolConfig({ ...validEnv(), BLOCK_SUBMIT_ATTEMPTS: '0' }), /BLOCK_SUBMIT_ATTEMPTS/);
    assert.equal(loadPoolConfig({ ...validEnv(), JOB_REBROADCAST_SECONDS: '3' }).jobRebroadcastSeconds, 3);
});

test('block reconciliation is bounded, defaults to 5 lookups 3 seconds apart, and rejects invalid values', () => {
    const defaults = loadPoolConfig(validEnv());
    assert.equal(defaults.blockReconcileAttempts, 5);
    assert.equal(defaults.blockReconcileRetryMs, 3000);
    const tuned = loadPoolConfig({ ...validEnv(), BLOCK_RECONCILE_ATTEMPTS: '2', BLOCK_RECONCILE_RETRY_MS: '200' });
    assert.equal(tuned.blockReconcileAttempts, 2);
    assert.equal(tuned.blockReconcileRetryMs, 200);
    assert.throws(() => loadPoolConfig({ ...validEnv(), BLOCK_RECONCILE_ATTEMPTS: '0' }), /BLOCK_RECONCILE_ATTEMPTS/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), BLOCK_RECONCILE_RETRY_MS: '50' }), /BLOCK_RECONCILE_RETRY_MS/);
});

test('worker logins use address.worker and validate the address checksum', () => {
    const versions = coin.addressVersions.mainnet;
    assert.deepEqual(parseWorkerLogin(`${mainAddress}.rig1`, versions), { address: mainAddress, worker: 'rig1' });
    assert.deepEqual(parseWorkerLogin(mainAddress, versions), { address: mainAddress, worker: 'default' });
    assert.equal(parseWorkerLogin(`${mainAddress.slice(0, -1)}1.rig1`, versions), null);
    assert.equal(parseWorkerLogin(`${encodeAddress(122, hash160)}.rig1`, versions), null);
    assert.equal(parseWorkerLogin(`${mainAddress}.bad worker`, versions), null);
    assert.equal(parseWorkerLogin(undefined, versions), null);
});

test('authorizer answers through the stratum callback and reports rejections', () => {
    const rejected = [];
    const authorize = createAuthorizer(coin.addressVersions.mainnet, mainAddress, (ip, login) => rejected.push([ip, login]));
    const results = [];
    authorize('1.2.3.4', 3333, `${mainAddress}.w`, 'x', (r) => results.push(r));
    const differentValidAddress = encodeAddress(60, Buffer.alloc(20, 8));
    authorize('1.2.3.4', 3333, `${differentValidAddress}.w`, 'x', (r) => results.push(r));
    authorize('1.2.3.4', 3333, 'nonsense', 'x', (r) => results.push(r));
    assert.deepEqual(results.map((r) => r.authorized), [true, false, false]);
    assert.deepEqual(rejected, [['1.2.3.4', `${differentValidAddress}.w`], ['1.2.3.4', 'nonsense']]);
});

test('connection and abuse limits default to safe values and can be tuned or disabled', () => {
    const defaults = loadPoolConfig(validEnv()).limits;
    assert.deepEqual(defaults, {
        maxConnections: 2000, maxConnectionsPerIp: 100, maxProtocolErrors: 20, handshakeTimeoutSeconds: 30,
        invalidSharePercent: 50, invalidShareCheckThreshold: 500,
        messageRateLimit: 1000, messageRateWindowSeconds: 10, maxOutputBufferBytes: 1048576
    });

    const tuned = loadPoolConfig({
        ...validEnv(), MAX_CONNECTIONS: '0', MAX_CONNECTIONS_PER_IP: '5', MAX_PROTOCOL_ERRORS: '3',
        HANDSHAKE_TIMEOUT_SECONDS: '0', INVALID_SHARE_PERCENT: '75', INVALID_SHARE_CHECK_THRESHOLD: '50',
        MESSAGE_RATE_LIMIT: '0', MESSAGE_RATE_WINDOW_SECONDS: '5', MAX_OUTPUT_BUFFER_BYTES: '0'
    }).limits;
    assert.deepEqual(tuned, {
        maxConnections: 0, maxConnectionsPerIp: 5, maxProtocolErrors: 3, handshakeTimeoutSeconds: 0,
        invalidSharePercent: 75, invalidShareCheckThreshold: 50,
        messageRateLimit: 0, messageRateWindowSeconds: 5, maxOutputBufferBytes: 0
    });
});

test('rejects invalid limit values', () => {
    for (const [name, value] of [['MAX_CONNECTIONS', '-1'], ['MAX_CONNECTIONS_PER_IP', '1.5'], ['MAX_PROTOCOL_ERRORS', 'x'],
        ['HANDSHAKE_TIMEOUT_SECONDS', '-5'], ['INVALID_SHARE_PERCENT', '101'], ['INVALID_SHARE_CHECK_THRESHOLD', '0'],
        ['MESSAGE_RATE_LIMIT', '-1'], ['MESSAGE_RATE_WINDOW_SECONDS', '0'], ['MAX_OUTPUT_BUFFER_BYTES', '100'], ['MAX_OUTPUT_BUFFER_BYTES', 'x']]) {
        assert.throws(() => loadPoolConfig({ ...validEnv(), [name]: value }), new RegExp(name), `${name}=${value}`);
    }
});

test('enables the private statistics API only with an absolute database path and strong token', () => {
    assert.equal(loadPoolConfig(validEnv()).statistics, null);
    const config = loadPoolConfig({
        ...validEnv(),
        POOL_STATS_DB: '/data/pool-stats.sqlite',
        POOL_STATS_PORT: '3334',
        POOL_STATS_TOKEN: 'a'.repeat(64)
    });
    assert.deepEqual(config.statistics, {
        path: '/data/pool-stats.sqlite',
        port: 3334,
        token: 'a'.repeat(64)
    });
    assert.throws(() => loadPoolConfig({ ...validEnv(), POOL_STATS_DB: 'pool.sqlite' }), /POOL_STATS_DB/);
    assert.throws(() => loadPoolConfig({ ...validEnv(), POOL_STATS_PORT: '3334' }), /POOL_STATS_DB/);
    assert.throws(() => loadPoolConfig({
        ...validEnv(), POOL_STATS_DB: '/data/pool-stats.sqlite', POOL_STATS_PORT: '3334', POOL_STATS_TOKEN: 'short'
    }), /POOL_STATS_TOKEN/);
});
