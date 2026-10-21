'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

function equalToken(received, expected) {
    const actual = Buffer.from(received);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function createStatsApi({ stats, port, token, log = () => {} }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Stats API port must be an integer from 1 to 65535');
    if (typeof token !== 'string' || token.length < 32) throw new Error('Stats API token must be at least 32 characters');

    const server = http.createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method !== 'GET' || request.url !== '/internal/stats') {
            response.writeHead(404).end();
            return;
        }
        const authorization = request.headers.authorization || '';
        const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!equalToken(suppliedToken, token)) {
            response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end('{"error":"unauthorized"}');
            return;
        }
        try {
            const summary = stats.summary();
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(summary));
        } catch (error) {
            log(`Private stats summary failed: ${error.message}`);
            response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end('{"error":"stats unavailable"}');
        }
    });

    return {
        listen() {
            return new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.removeListener('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, '0.0.0.0');
            });
        },
        close() {
            return new Promise((resolve, reject) => {
                if (!server.listening) return resolve();
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    };
}

module.exports = { createStatsApi };
