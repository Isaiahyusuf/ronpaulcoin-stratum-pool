'use strict';

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const PUBLIC_FILES = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function readConfig(env) {
    const host = env.STRATUM_PUBLIC_HOST;
    const port = Number(env.STRATUM_PUBLIC_PORT);
    const address = env.POOL_ADDRESS;
    if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('STRATUM_PUBLIC_HOST must be a hostname');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STRATUM_PUBLIC_PORT must be an integer from 1 to 65535');
    if (!address || !/^[A-Za-z0-9]+$/.test(address)) throw new Error('POOL_ADDRESS must be configured');
    const webPort = env.PORT === undefined ? 3000 : Number(env.PORT);
    if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65535) throw new Error('PORT must be an integer from 0 to 65535');
    return { host, port, address, webPort };
}

function probeTcp(host, port, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        let settled = false;
        const finish = (connected) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(connected);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

function sendJson(response, status, value) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(value));
}

function createRateLimiter({ maxRequests = 60, windowMs = 60_000, now = Date.now } = {}) {
    const clients = new Map();
    return (key) => {
        const currentTime = now();
        let entry = clients.get(key);
        if (!entry || currentTime >= entry.expiresAt) {
            entry = { count: 0, expiresAt: currentTime + windowMs };
            clients.set(key, entry);
        }
        entry.count += 1;
        if (clients.size > 1000) {
            for (const [client, state] of clients) {
                if (currentTime >= state.expiresAt) clients.delete(client);
            }
        }
        return entry.count <= maxRequests;
    };
}

function createDashboardServer({ env = process.env, probe = probeTcp, now = () => new Date() } = {}) {
    const config = readConfig(env);
    const allowApiRequest = createRateLimiter();
    const publicDir = path.join(__dirname, 'public');

    return http.createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        response.setHeader('Strict-Transport-Security', 'max-age=31536000');

        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.setHeader('Allow', 'GET, HEAD');
            response.writeHead(405);
            response.end();
            return;
        }

        if (pathname === '/healthz') {
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(request.method === 'HEAD' ? undefined : 'ok');
            return;
        }

        if (pathname === '/api/status') {
            const client = request.socket.remoteAddress || 'unknown';
            if (!allowApiRequest(client)) {
                sendJson(response, 429, { error: 'Rate limit exceeded. Retry shortly.' });
                return;
            }

            let reachable = false;
            let probeFailed = false;
            try {
                reachable = await probe(config.host, config.port);
            } catch {
                probeFailed = true;
            }
            const checkedAt = now().toISOString();
            sendJson(response, 200, {
                generatedAt: checkedAt,
                pool: {
                    status: probeFailed ? 'unavailable' : reachable ? 'reachable' : 'offline',
                    error: probeFailed ? 'The TCP health check could not complete.' : null,
                    checkedAt,
                    endpoint: { host: config.host, port: config.port, protocol: 'Stratum TCP' }
                },
                mining: {
                    poolHashrate: null,
                    networkHashrate: null,
                    connectedMiners: null,
                    connectedWorkers: null,
                    acceptedShares: null,
                    rejectedShares: null,
                    staleShares: null,
                    blocksFound: null,
                    lastBlock: null,
                    recentActivity: null,
                    unavailableReason: 'The pool does not persist share, worker, hashrate, or block statistics.'
                },
                network: {
                    daemonRpc: 'unavailable',
                    synchronization: 'unverified',
                    height: null,
                    bestHash: null,
                    latestBlockTime: null,
                    difficulty: null,
                    blockReward: null,
                    peers: null,
                    template: 'unavailable',
                    warning: 'The dashboard intentionally has no daemon RPC access. Mainnet synchronization and canonical-chain status are not independently verified.'
                },
                connection: {
                    host: config.host,
                    port: config.port,
                    protocol: 'Stratum TCP',
                    loginFormat: `${config.address}.<worker>`,
                    workerRule: 'Worker names may contain letters, digits, underscore, and hyphen (1-32 characters).',
                    passwordFormat: 'Any password string; the pool does not use it for authentication.',
                    rewardAddress: config.address
                },
                solo: {
                    payout: 'A successfully mined block pays the configured reward address.',
                    distribution: 'This pool does not distribute rewards to miners or account for proportional payouts.',
                    probability: 'Finding a block is probabilistic and is not guaranteed.'
                }
            });
            return;
        }

        const file = PUBLIC_FILES.get(pathname);
        if (!file) {
            response.writeHead(404, { 'Cache-Control': 'no-store' });
            response.end();
            return;
        }
        const [name, contentType] = file;
        fs.readFile(path.join(publicDir, name), (error, content) => {
            if (error) {
                response.writeHead(500, { 'Cache-Control': 'no-store' });
                response.end();
                return;
            }
            response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
            response.end(request.method === 'HEAD' ? undefined : content);
        });
    });
}

if (require.main === module) {
    const server = createDashboardServer();
    const port = Number(process.env.PORT || 3000);
    server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${port}`));
}

module.exports = { createDashboardServer, createRateLimiter, probeTcp, readConfig };
