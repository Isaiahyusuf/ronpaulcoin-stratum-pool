const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const stratum = require('../vendor/stratum-pool/lib/stratum');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TestMiner {
    constructor(socket) {
        this.socket = socket;
        this.messages = [];
        this.closed = false;
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) if (line) this.messages.push(JSON.parse(line));
        });
        socket.on('close', () => { this.closed = true; });
        socket.on('error', () => {});
    }

    send(message) {
        this.socket.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    }

    async reply(id, timeoutMs = 1000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = this.messages.find((message) => message.id === id);
            if (found) return found;
            await delay(5);
        }
        throw new Error(`no reply to request ${id}`);
    }

    async waitForClose(timeoutMs = 1500) {
        const deadline = Date.now() + timeoutMs;
        while (!this.closed && Date.now() < deadline) await delay(10);
        return this.closed;
    }
}

// Real StratumServer and StratumClient over local sockets; the pool-level handlers are replaced by fixtures.
describe('stratum server protocol and connection safety', () => {
    let server;
    let listener;
    let port;
    let miners;
    let events;
    let submitHandler;

    const start = async (options = {}) => {
        events = [];
        server = new stratum.Server({
            ports: {},
            connectionTimeout: 600,
            jobRebroadcastTimeout: 55,
            banning: { enabled: false },
            ...options
        }, (ip, localPort, login, password, callback) => callback({ error: null, authorized: login.startsWith('good'), disconnect: false }));
        server.on('connectionRejected', (ip, reason) => events.push(['connectionRejected', ip, reason]));
        server.on('client.connected', (client) => {
            client.on('subscription', (params, done) => done(null, 'aabbccdd', 4));
            client.on('submit', (params, done) => submitHandler(params, done));
            for (const name of ['protocolErrorLimit', 'handshakeTimeout', 'rateLimitExceeded', 'outputBufferLimit', 'socketError', 'triggerBan', 'unknownStratumMethod']) {
                client.on(name, (...args) => events.push([name, ...args]));
            }
        });
        listener = net.createServer((socket) => server.handleNewClient(socket));
        await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
        port = listener.address().port;
    };

    const connect = async () => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        const miner = new TestMiner(socket);
        miners.push(miner);
        return miner;
    };

    const handshake = async (miner, login = 'good.worker') => {
        miner.send({ id: 1, method: 'mining.subscribe', params: [] });
        await miner.reply(1);
        miner.send({ id: 2, method: 'mining.authorize', params: [login, 'x'] });
        return miner.reply(2);
    };

    const eventCount = (name) => events.filter(([event]) => event === name).length;

    beforeEach(() => {
        miners = [];
        submitHandler = (params, done) => done(null, true);
    });

    afterEach(async () => {
        miners.forEach((miner) => miner.socket.destroy());
        await new Promise((resolve) => listener.close(resolve));
    });

    describe('protocol responses', () => {
        beforeEach(() => start());

        it('keeps the subscribe, authorize and submit exchange unchanged', async () => {
            const miner = await connect();
            miner.send({ id: 1, method: 'mining.subscribe', params: ['cpuminer/2.5'] });
            const subscribed = await miner.reply(1);
            assert.equal(subscribed.error, null);
            assert.equal(subscribed.result[1], 'aabbccdd');
            assert.equal(subscribed.result[2], 4);
            assert.equal(subscribed.result[0][0][0], 'mining.set_difficulty');

            assert.deepEqual((await handshake(await connect())).result, true);
            miner.send({ id: 2, method: 'mining.authorize', params: ['good.rig1', 'x'] });
            assert.equal((await miner.reply(2)).result, true);

            let seenName;
            submitHandler = (params, done) => { seenName = params.name; done(null, true); };
            miner.send({ id: 3, method: 'mining.submit', params: ['good.other', 'job', '00000000', '5f000000', '00000001'] });
            assert.deepEqual(await miner.reply(3), { id: 3, result: true, error: null });
            assert.equal(seenName, 'good.rig1');
        });

        it('closes active miner sockets on shutdown', async () => {
            const miner = await connect();
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
            assert.equal(await miner.waitForClose(), true);
        });

        it('rejects a failed authorization with result false', async () => {
            const miner = await connect();
            const reply = await handshake(miner, 'bad-login');
            assert.equal(reply.result, false);
        });

        it('answers mining.configure by declining every requested extension', async () => {
            const miner = await connect();
            miner.send({ id: 7, method: 'mining.configure', params: [['version-rolling', 'minimum-difficulty'], { 'version-rolling.mask': 'ffffffff' }] });
            assert.deepEqual(await miner.reply(7), { id: 7, result: { 'version-rolling': false, 'minimum-difficulty': false }, error: null });

            miner.send({ id: 8, method: 'mining.configure', params: [] });
            assert.deepEqual(await miner.reply(8), { id: 8, result: {}, error: null });

            miner.send({ id: 9, method: 'mining.configure', params: [['__proto__', 42]] });
            assert.equal((await miner.reply(9)).error, null);
        });

        it('answers mining.extranonce.subscribe with an explicit refusal', async () => {
            const miner = await connect();
            miner.send({ id: 4, method: 'mining.extranonce.subscribe', params: [] });
            const reply = await miner.reply(4);
            assert.equal(reply.result, false);
            assert.equal(reply.error[0], 20);
            assert.match(reply.error[1], /not supported/);
        });

        it('answers mining.get_transactions with the request id and an error', async () => {
            const miner = await connect();
            miner.send({ id: 5, method: 'mining.get_transactions', params: ['job'] });
            const reply = await miner.reply(5);
            assert.equal(reply.id, 5);
            assert.equal(reply.result, null);
            assert.equal(reply.error[0], 20);
        });

        it('answers unknown methods with an error when a request id is present and stays silent for notifications', async () => {
            const miner = await connect();
            miner.send({ id: 6, method: 'mining.made_up', params: [] });
            const reply = await miner.reply(6);
            assert.deepEqual(reply, { id: 6, result: null, error: [20, 'Unsupported method', null] });

            miner.send({ id: null, method: 'mining.made_up', params: [] });
            miner.send({ method: 'mining.made_up' });
            miner.send({ id: 10, method: 'mining.configure', params: [] });
            await miner.reply(10);
            assert.equal(miner.messages.filter((message) => message.id === null || message.id === undefined).length, 0);
            assert.equal(eventCount('unknownStratumMethod'), 3);
        });

        it('does not write to a connection that closed while a submission was pending', async () => {
            const miner = await connect();
            await handshake(miner);
            submitHandler = (params, done) => setTimeout(() => done(null, true), 100);
            miner.send({ id: 3, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });
            await delay(20);
            miner.socket.destroy();
            await delay(250);

            assert.equal(eventCount('socketError'), 0);
        });
    });

    describe('connection limits', () => {
        it('rejects connections beyond the per-address limit and accepts again after one closes', async () => {
            await start({ maxConnectionsPerIp: 2, maxConnections: 0 });
            const first = await connect();
            await connect();
            const third = await connect();

            assert.equal(await third.waitForClose(), true);
            assert.equal(first.closed, false);
            assert.equal(events.filter(([event, , reason]) => event === 'connectionRejected' && /per address/.test(reason)).length, 1);

            first.socket.destroy();
            await first.waitForClose();
            await delay(50);
            const fourth = await connect();
            assert.deepEqual((await handshake(fourth)).result, true);
        });

        it('rejects connections beyond the total limit', async () => {
            await start({ maxConnections: 1, maxConnectionsPerIp: 0 });
            await connect();
            const second = await connect();

            assert.equal(await second.waitForClose(), true);
            assert.match(events.find(([event]) => event === 'connectionRejected')[2], /server connection limit/);
        });

        it('applies no limit when the limits are 0', async () => {
            await start({ maxConnections: 0, maxConnectionsPerIp: 0 });
            const connected = [];
            for (let i = 0; i < 25; i++) connected.push(await connect());
            await delay(100);

            assert.ok(connected.every((miner) => !miner.closed));
            assert.equal(eventCount('connectionRejected'), 0);
        });

        it('frees the slot when a rejected-then-retrying miner disconnects normally', async () => {
            await start({ maxConnectionsPerIp: 1, maxConnections: 0 });
            for (let i = 0; i < 5; i++) {
                const miner = await connect();
                assert.deepEqual((await handshake(miner)).result, true);
                miner.socket.destroy();
                await miner.waitForClose();
                await delay(30);
            }
            assert.equal(eventCount('connectionRejected'), 0);
        });
    });

    describe('abuse limits', () => {
        it('disconnects a connection that keeps submitting without authorizing', async () => {
            await start({ maxProtocolErrors: 5 });
            const miner = await connect();
            for (let id = 1; id <= 8; id++) miner.send({ id, method: 'mining.submit', params: ['w', 'job', '00000000', '5f000000', '00000001'] });

            assert.equal(await miner.waitForClose(), true);
            assert.equal(eventCount('protocolErrorLimit'), 1);
        });

        it('disconnects a connection that keeps failing authorization', async () => {
            await start({ maxProtocolErrors: 4 });
            const miner = await connect();
            miner.send({ id: 1, method: 'mining.subscribe', params: [] });
            for (let id = 2; id <= 6; id++) miner.send({ id, method: 'mining.authorize', params: ['bad', 'x'] });

            assert.equal(await miner.waitForClose(), true);
            assert.equal(eventCount('protocolErrorLimit'), 1);
        });

        it('disconnects a connection that repeats malformed submissions or unknown methods', async () => {
            await start({ maxProtocolErrors: 5 });
            const malformed = await connect();
            await handshake(malformed);
            for (let id = 10; id < 20; id++) malformed.send({ id, method: 'mining.submit', params: [1, 2] });
            assert.equal(await malformed.waitForClose(), true);

            const unknown = await connect();
            for (let id = 10; id < 20; id++) unknown.send({ id, method: 'mining.nonsense', params: [] });
            assert.equal(await unknown.waitForClose(), true);
        });

        it('limits repeated subscribe requests on one connection', async () => {
            await start({ maxProtocolErrors: 5 });
            const miner = await connect();
            for (let id = 1; id <= 8; id++) miner.send({ id, method: 'mining.subscribe', params: [] });

            assert.equal(await miner.waitForClose(), true);
        });

        it('never disconnects a miner that submits many valid shares and the usual optional requests', async () => {
            await start({ maxProtocolErrors: 5 });
            const miner = await connect();
            await handshake(miner);
            miner.send({ id: 100, method: 'mining.configure', params: [['version-rolling']] });
            miner.send({ id: 101, method: 'mining.extranonce.subscribe', params: [] });
            miner.send({ id: 102, method: 'mining.suggest_difficulty', params: [1] });
            for (let id = 200; id < 400; id++) {
                miner.send({ id, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });
                if (id % 25 === 0) await delay(5);
            }
            await miner.reply(399);

            assert.equal(miner.closed, false);
            assert.equal(eventCount('protocolErrorLimit'), 0);
        });

        it('disconnects connections that do not finish subscribe and authorize in time', async () => {
            await start({ handshakeTimeout: 0.2 });
            const silent = await connect();
            const subscribedOnly = await connect();
            subscribedOnly.send({ id: 1, method: 'mining.subscribe', params: [] });
            const complete = await connect();
            await handshake(complete);

            assert.equal(await silent.waitForClose(), true);
            assert.equal(await subscribedOnly.waitForClose(), true);
            assert.equal(eventCount('handshakeTimeout'), 2);
            await delay(100);
            assert.equal(complete.closed, false);
        });

        it('disconnects on an invalid-share ratio measured over each window, not over the connection lifetime', async () => {
            await start({ banning: { enabled: true, time: 0, invalidPercent: 50, checkThreshold: 10, purgeInterval: 300 } });
            const miner = await connect();
            await handshake(miner);
            let outcomes = [...Array(9).fill(true), false, ...Array(4).fill(true), ...Array(6).fill(false)];
            submitHandler = (params, done) => (outcomes.shift() ? done(null, true) : done([23, 'low difficulty share', null], null));
            outcomes = [...Array(9).fill(true), false, ...Array(4).fill(true), ...Array(6).fill(false)];
            for (let id = 100; id < 120; id++) miner.send({ id, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });

            assert.equal(await miner.waitForClose(), true);
            assert.equal(eventCount('triggerBan'), 1);
        });

        it('does not disconnect a miner whose invalid shares stay below the threshold ratio', async () => {
            await start({ banning: { enabled: true, time: 0, invalidPercent: 50, checkThreshold: 10, purgeInterval: 300 } });
            const miner = await connect();
            await handshake(miner);
            let count = 0;
            submitHandler = (params, done) => (++count % 10 === 0 ? done([21, 'job not found', null], null) : done(null, true));
            for (let id = 100; id < 160; id++) miner.send({ id, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });
            await miner.reply(159);

            assert.equal(miner.closed, false);
            assert.equal(eventCount('triggerBan'), 0);
        });

        it('treats a window at exactly the configured percentage as a violation and one below it as clean', async () => {
            await start({ banning: { enabled: true, time: 0, invalidPercent: 50, checkThreshold: 4, purgeInterval: 300 } });
            const run = async (outcomes) => {
                const miner = await connect();
                await handshake(miner);
                submitHandler = (params, done) => (outcomes.shift() ? done(null, true) : done([23, 'low difficulty share', null], null));
                const count = outcomes.length;
                for (let id = 100; id < 100 + count; id++) miner.send({ id, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });
                await delay(200);
                return miner.closed;
            };
            assert.equal(await run([true, true, false, false]), true);
            assert.equal(await run([false, true, true, true]), false);
        });

        it('disconnects on an invalid ratio without banning the address when the ban time is 0', async () => {
            await start({ banning: { enabled: true, time: 0, invalidPercent: 50, checkThreshold: 5, purgeInterval: 300 } });
            const abuser = await connect();
            await handshake(abuser);
            submitHandler = (params, done) => done([23, 'low difficulty share', null], null);
            for (let id = 100; id < 110; id++) abuser.send({ id, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });
            assert.equal(await abuser.waitForClose(), true);

            const neighbour = await connect();
            assert.deepEqual((await handshake(neighbour)).result, true);
            await delay(100);
            assert.equal(neighbour.closed, false);
        });
    });

    describe('request rate and output backpressure', () => {
        const submission = (id) => ({ id, method: 'mining.submit', params: ['good.w', 'job', '00000000', '5f000000', '00000001'] });

        it('disconnects a client that exceeds the message rate, whatever the messages are', async () => {
            for (const line of [(i) => JSON.stringify({ id: i, method: 'mining.configure', params: [[]] }), () => '', () => JSON.stringify({ method: 'mining.suggest_difficulty', params: [1] })]) {
                await start({ messageRateLimit: 50, messageRateWindow: 10, maxConnections: 1 });
                const miner = await connect();
                miner.send(Array.from({ length: 80 }, (_, i) => line(i + 1)).join('\n'));
                assert.equal(await miner.waitForClose(), true);
                assert.equal(eventCount('rateLimitExceeded'), 1);
                await new Promise((resolve) => listener.close(resolve));
            }
        });

        it('does not disconnect a miner that submits shares quickly within the limit and resets each window', async () => {
            await start({ messageRateLimit: 100, messageRateWindow: 1 });
            const miner = await connect();
            await handshake(miner);
            let id = 100;
            for (let round = 0; round < 3; round++) {
                for (let i = 0; i < 90; i++) miner.send(submission(id++));
                await miner.reply(id - 1);
                await delay(1050);
            }
            assert.equal(miner.closed, false);
            assert.equal(eventCount('rateLimitExceeded'), 0);
        });

        it('accepts a large burst of complete messages in one write but drops oversized lines', async () => {
            await start({ messageRateLimit: 0 });
            const miner = await connect();
            await handshake(miner);
            miner.send(Array.from({ length: 400 }, (_, i) => JSON.stringify(submission(100 + i))).join('\n'));
            assert.equal((await miner.reply(499)).error, null);
            assert.equal(miner.closed, false);

            for (const payload of [`${'x'.repeat(20000)}\n`, 'x'.repeat(20000)]) {
                const flooder = await connect();
                flooder.socket.write(payload);
                assert.equal(await flooder.waitForClose(), true);
            }
        });

        it('measures the message size limit in UTF-8 bytes for complete and unfinished lines', async () => {
            await start({ messageRateLimit: 0 });
            const line = (count) => `${JSON.stringify({ id: 1, method: 'mining.configure', params: [['é'.repeat(count)]] })}`;
            const accepted = await connect();
            accepted.send(line(4000));
            assert.equal((await accepted.reply(1)).error, null);

            for (const payload of [`${line(8000)}\n`, line(8000)]) {
                const flooder = await connect();
                flooder.socket.write(payload);
                assert.equal(await flooder.waitForClose(), true);
            }
        });

        it('reassembles messages split across packets, including inside a multibyte character', async () => {
            await start({ messageRateLimit: 0 });
            const miner = await connect();
            const bytes = Buffer.from('{"id":7,"method":"mining.configure","params":[["é€x"]]}\n{"id":8,"method":"mining.configure","params":[[]]}\n');
            for (const byte of bytes) {
                miner.socket.write(Buffer.from([byte]));
                await delay(1);
            }
            assert.deepEqual((await miner.reply(7)).result, { 'é€x': false });
            assert.deepEqual((await miner.reply(8)).result, {});
            assert.equal(miner.closed, false);
        });

        it('allows exactly the configured number of messages per window and closes on the next, counting blank lines', async () => {
            await start({ messageRateLimit: 50, messageRateWindow: 10 });
            const exact = await connect();
            exact.send(Array.from({ length: 25 }, (_, i) => JSON.stringify({ id: i + 1, method: 'mining.configure' })).join('\n\n'));
            exact.send('');
            assert.equal((await exact.reply(25)).error, null);
            assert.equal(exact.closed, false);

            const over = await connect();
            over.send(Array.from({ length: 26 }, (_, i) => JSON.stringify({ id: i + 1, method: 'mining.configure' })).join('\n\n'));
            assert.equal(await over.waitForClose(), true);
        });

        it('keeps the window correct when the wall clock steps backwards', async () => {
            await start({ messageRateLimit: 20, messageRateWindow: 1 });
            const miner = await connect();
            await handshake(miner);
            const realNow = Date.now;
            Date.now = () => realNow() - 3600 * 1000;
            try {
                for (let round = 0; round < 3; round++) {
                    for (let i = 0; i < 15; i++) miner.send({ id: 1000 + round * 100 + i, method: 'mining.configure', params: [[]] });
                    await miner.reply(1000 + round * 100 + 14);
                    await delay(1050);
                }
            } finally {
                Date.now = realNow;
            }
            assert.equal(miner.closed, false);
            assert.equal(eventCount('rateLimitExceeded'), 0);
        });

        it('survives clients that reset the connection while replies are queued', async () => {
            await start({ messageRateLimit: 0, maxOutputBuffer: 65536 });
            const names = JSON.stringify([Array.from({ length: 500 }, (_, i) => `ext-${i}`.padEnd(8, 'x'))]);
            for (let attempt = 0; attempt < 20; attempt++) {
                const miner = await connect();
                miner.send(Array.from({ length: 5 }, (_, i) => `{"id":${i + 1},"method":"mining.configure","params":${names}}`).join('\n'));
                miner.socket.resetAndDestroy();
            }
            await delay(300);
            assert.equal(Object.keys(server.getStratumClients()).length, 0);
            for (const [name, error] of events) if (name === 'socketError') assert.ok(['EPIPE', 'ECONNRESET'].includes(error.code), error.code);
            const next = await connect();
            assert.deepEqual((await handshake(next)).result, true);
        });

        it('applies no rate limit when set to 0', async () => {
            await start({ messageRateLimit: 0, messageRateWindow: 1 });
            const miner = await connect();
            await handshake(miner);
            for (let id = 100; id < 1100; id++) miner.send(submission(id));
            await miner.reply(1099, 3000);
            assert.equal(miner.closed, false);
        });

        it('disconnects a client that never reads its replies and frees its connection slot', async () => {
            await start({ messageRateLimit: 0, maxOutputBuffer: 65536, maxConnections: 1 });
            const stalled = await connect();
            stalled.socket.pause();
            const names = JSON.stringify([Array.from({ length: 500 }, (_, i) => `ext-${i}`.padEnd(8, 'x'))]);
            const request = `{"id":1,"method":"mining.configure","params":${names}}\n`.repeat(1);
            const deadline = Date.now() + 20000;
            while (eventCount('outputBufferLimit') === 0 && Date.now() < deadline) {
                if (stalled.socket.writableLength > 1 << 20) await new Promise((resolve) => { stalled.socket.once('drain', resolve); setTimeout(resolve, 200); });
                stalled.socket.write(request);
                await delay(0);
            }
            assert.equal(eventCount('outputBufferLimit'), 1);
            assert.equal(eventCount('socketError'), 0);

            await delay(100);
            assert.equal(Object.keys(server.getStratumClients()).length, 0);
            const next = await connect();
            assert.deepEqual((await handshake(next)).result, true);
        });

        it('does not disconnect a miner that reads normally even with a small output limit', async () => {
            await start({ messageRateLimit: 0, maxOutputBuffer: 65536 });
            const miner = await connect();
            await handshake(miner);
            for (let id = 100; id < 1100; id++) miner.send(submission(id));
            await miner.reply(1099, 3000);
            assert.equal(eventCount('outputBufferLimit'), 0);
            assert.equal(miner.closed, false);
        });
    });
});
