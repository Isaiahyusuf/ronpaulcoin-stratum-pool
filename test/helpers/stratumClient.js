const net = require('node:net');

class StratumClient {
    constructor(socket) {
        this.socket = socket;
        this.buffer = '';
        this.nextId = 1;
        this.pending = new Map();
        this.inbox = [];
        this.waiters = [];
        this.closed = false;

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => {
            this.closed = true;
            for (const waiter of this.waiters) waiter.reject(new Error('connection closed'));
            this.waiters = [];
        });
        socket.on('error', () => {});
    }

    static connect(port, host = '127.0.0.1') {
        return new Promise((resolve, reject) => {
            const socket = net.connect({ port, host }, () => resolve(new StratumClient(socket)));
            socket.once('error', reject);
        });
    }

    onData(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();
        for (const line of lines) {
            if (!line) continue;
            const message = JSON.parse(line);
            const pending = message.id !== null && message.id !== undefined && this.pending.get(message.id);
            if (pending) {
                this.pending.delete(message.id);
                pending(message);
            } else {
                this.inbox.push(message);
                this.flushWaiters();
            }
        }
    }

    flushWaiters() {
        this.waiters = this.waiters.filter((waiter) => {
            const index = this.inbox.findIndex(waiter.predicate);
            if (index === -1) return true;
            waiter.resolve(this.inbox.splice(index, 1)[0]);
            return false;
        });
    }

    sendRaw(text) {
        this.socket.write(text);
    }

    request(method, params, timeoutMs = 10000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`no response to ${method}`));
            }, timeoutMs);
            this.pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            this.sendRaw(`${JSON.stringify({ id, method, params })}\n`);
        });
    }

    waitFor(predicate, timeoutMs = 10000, description = 'message') {
        const index = this.inbox.findIndex(predicate);
        if (index !== -1) return Promise.resolve(this.inbox.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve: (m) => { clearTimeout(timer); resolve(m); }, reject };
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w !== waiter);
                reject(new Error(`timed out waiting for ${description}`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    waitForNotification(method, timeoutMs) {
        return this.waitFor((m) => m.method === method, timeoutMs, method);
    }

    waitForClose(timeoutMs = 5000) {
        if (this.closed) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('socket was not closed')), timeoutMs);
            this.socket.once('close', () => { clearTimeout(timer); resolve(); });
        });
    }

    close() {
        this.socket.destroy();
    }
}

module.exports = { StratumClient };
