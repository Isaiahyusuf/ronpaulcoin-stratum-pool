const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const daemon = require('../vendor/stratum-pool/lib/daemon');

const PASSWORD = 'sensitive-password';
const TIMEOUT_MS = 300;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Local HTTP fixture standing in for a daemon; each test installs the behaviour it needs.
describe('vendored daemon interface', () => {
    let server;
    let port;
    let behave;
    let receivedAuthorization;
    const logs = [];

    const respondJson = (response, body, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    const unusedPort = () => new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address();
            probe.close(() => resolve(free));
        });
    });

    const createInterface = (overrides = {}, targetPort = port) => new daemon.interface(
        [{ host: '127.0.0.1', port: targetPort, user: 'rpcuser', password: PASSWORD, timeoutMs: TIMEOUT_MS, ...overrides }],
        (severity, message) => logs.push(`${severity}: ${message}`)
    );

    // Runs one command and proves the callback fires exactly once and within the timeout.
    const runCommand = async (instance) => {
        const started = Date.now();
        let calls = 0;
        const results = await new Promise((resolve) => instance.cmd('getinfo', [], (r) => { calls++; resolve(r); }));
        const elapsed = Date.now() - started;
        await delay(TIMEOUT_MS + 150);
        assert.equal(calls, 1, 'callback must fire exactly once');
        assert.ok(elapsed < TIMEOUT_MS + 700, `request took ${elapsed} ms`);
        assert.equal(results.length, 1);
        return results[0];
    };

    before(async () => {
        server = http.createServer((request, response) => {
            receivedAuthorization = request.headers.authorization;
            request.resume();
            request.on('end', () => behave(request, response));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
    });

    it('authenticates with the configured credentials but never serialises the password', async () => {
        behave = (request, response) => respondJson(response, { result: 'ok', error: null, id: 1 });
        const result = await runCommand(createInterface());

        assert.equal(result.response, 'ok');
        const basic = Buffer.from(receivedAuthorization.replace('Basic ', ''), 'base64').toString();
        assert.equal(basic, `rpcuser:${PASSWORD}`);
        assert.doesNotMatch(JSON.stringify(result), /sensitive-password/);
        assert.doesNotMatch(JSON.stringify(result.instance), /sensitive-password/);
    });

    it('uses a fresh connection for every request so a stale socket cannot queue a request for later delivery', async () => {
        const seen = [];
        behave = (request, response) => {
            seen.push({ port: request.socket.remotePort, connection: request.headers.connection });
            respondJson(response, { result: 1, error: null, id: 1 });
        };
        const instance = createInterface();
        for (let i = 0; i < 3; i++) assert.equal((await runCommand(instance)).error, null);
        assert.equal(seen.length, 3);
        assert.equal(new Set(seen.map((entry) => entry.port)).size, 3, 'each request must open its own connection');
        for (const entry of seen) assert.equal(entry.connection, 'close');
    });

    it('reports HTTP 401 as a non-retryable unauthorized error without leaking credentials', async () => {
        logs.length = 0;
        behave = (request, response) => respondJson(response, 'Unauthorized', 401);
        const result = await runCommand(createInterface());

        assert.equal(result.error.type, 'unauthorized');
        assert.equal(result.response, undefined);
        assert.ok(logs.some((line) => /Unauthorized RPC access/.test(line)));
        assert.doesNotMatch(JSON.stringify([result, logs]), /sensitive-password|Basic /);
    });

    it('passes through a JSON-RPC error carried by a non-2xx status', async () => {
        behave = (request, response) => respondJson(response, { result: null, error: { code: -32601, message: 'Method not found' }, id: 1 }, 404);
        const result = await runCommand(createInterface());

        assert.deepEqual(result.error, { code: -32601, message: 'Method not found' });
    });

    it('reports a non-2xx status without a JSON-RPC error as an http error', async () => {
        behave = (request, response) => respondJson(response, '<html>bad gateway</html>', 502);
        const result = await runCommand(createInterface());

        assert.equal(result.error.type, 'http error');
        assert.match(result.error.message, /502/);
    });

    for (const [label, body] of [['an empty body', ''], ['malformed JSON', '{"result":'], ['a JSON null', 'null'], ['a JSON string', '"ok"']]) {
        it(`reports ${label} on a 200 response as a parse error`, async () => {
            behave = (request, response) => respondJson(response, body);
            const result = await runCommand(createInterface());

            assert.equal(result.error.type, 'parse error');
        });
    }

    it('still parses daemon output containing -nan values', async () => {
        behave = (request, response) => respondJson(response, '{"result":{"hashps":-nan,"x":1},"error":null,"id":1}');
        const result = await runCommand(createInterface());

        assert.equal(result.error, null);
        assert.equal(result.response.hashps, 0);
    });

    it('reports a connection reset as a retryable request error', async () => {
        behave = (request) => request.socket.destroy();
        const result = await runCommand(createInterface());

        assert.equal(result.error.type, 'request error');
    });

    it('reports a response cut off mid-body as a retryable request error', async () => {
        behave = (request, response) => {
            response.writeHead(200, { 'Content-Length': 1000 });
            response.write('{"result":');
            setTimeout(() => request.socket.destroy(), 20);
        };
        const result = await runCommand(createInterface());

        assert.equal(result.error.type, 'request error');
    });

    it('terminates a hung connection at the configured timeout', async () => {
        behave = () => {};
        const result = await runCommand(createInterface());

        assert.equal(result.error.type, 'request error');
        assert.match(result.error.message, /timed out/);
    });

    it('terminates a response that keeps trickling data at the configured timeout', async () => {
        let trickle;
        behave = (request, response) => {
            response.writeHead(200, { 'Content-Length': 100000 });
            trickle = setInterval(() => response.write(' '), 20);
            response.on('close', () => clearInterval(trickle));
        };
        const result = await runCommand(createInterface());

        assert.equal(result.error.type, 'request error');
        assert.match(result.error.message, /timed out/);
    });

    it('reports a refused connection as offline', async () => {
        const result = await runCommand(createInterface({}, await unusedPort()));

        assert.equal(result.error.type, 'offline');
    });

    it('completes a batch request exactly once on success and on failure', async () => {
        const batch = (instance) => new Promise((resolve) => {
            let calls = 0;
            instance.batchCmd([['getinfo', []], ['getdifficulty', []]], (error, results) => {
                calls++;
                resolve({ error, results, calls: () => calls });
            });
        });

        behave = (request, response) => respondJson(response, [{ result: 1, error: null }, { result: 2, error: null }]);
        const ok = await batch(createInterface());
        assert.equal(ok.error, null);
        assert.equal(ok.results.length, 2);

        behave = (request, response) => respondJson(response, 'Unauthorized', 401);
        const unauthorized = await batch(createInterface());
        assert.equal(unauthorized.error.type, 'unauthorized');

        behave = () => {};
        const hung = await batch(createInterface());
        assert.equal(hung.error.type, 'request error');
        await delay(TIMEOUT_MS + 150);
        assert.equal(hung.calls(), 1);
    });

    it('returns one result per daemon when only some fail', async () => {
        behave = (request, response) => respondJson(response, { result: 'ok', error: null, id: 1 });
        const instance = new daemon.interface([
            { host: '127.0.0.1', port, user: 'u', password: PASSWORD, timeoutMs: TIMEOUT_MS },
            { host: '127.0.0.1', port: await unusedPort(), user: 'u', password: PASSWORD, timeoutMs: TIMEOUT_MS }
        ], () => {});
        let calls = 0;
        const results = await new Promise((resolve) => instance.cmd('getinfo', [], (r) => { calls++; resolve(r); }));
        await delay(100);

        assert.equal(calls, 1);
        const byIndex = [...results].sort((a, b) => a.instance.index - b.instance.index);
        assert.equal(byIndex[0].response, 'ok');
        assert.equal(byIndex[1].error.type, 'offline');
    });

    describe('isOnline', () => {
        it('reports an unreachable daemon as offline and emits connectionFailed without credentials', async () => {
            const instance = createInterface({}, await unusedPort());
            const failures = [];
            instance.on('connectionFailed', (results) => failures.push(results));
            const online = await new Promise((resolve) => instance.isOnline(resolve));

            assert.equal(online, false);
            assert.equal(failures.length, 1);
            assert.doesNotMatch(JSON.stringify(failures), /sensitive-password/);
        });

        it('reports rejected credentials as offline', async () => {
            behave = (request, response) => respondJson(response, 'Unauthorized', 401);
            const online = await new Promise((resolve) => createInterface().isOnline(resolve));

            assert.equal(online, false);
        });

        it('reports a responding daemon as online and init emits online only then', async () => {
            behave = (request, response) => respondJson(response, { result: [], error: null, id: 1 });
            const online = await new Promise((resolve) => createInterface().isOnline(resolve));
            assert.equal(online, true);

            const emitted = await new Promise((resolve) => {
                const instance = createInterface();
                instance.once('online', () => resolve(true));
                instance.init();
            });
            assert.equal(emitted, true);

            const unreachable = createInterface({}, await unusedPort());
            let falseOnline = false;
            unreachable.on('online', () => { falseOnline = true; });
            unreachable.on('connectionFailed', () => {});
            unreachable.init();
            await delay(200);
            assert.equal(falseOnline, false);
        });
    });
});
