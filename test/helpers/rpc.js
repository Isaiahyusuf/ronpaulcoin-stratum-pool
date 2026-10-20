function createRpcClient({ host, port, user, password }) {
    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    let nextId = 1;

    return async function call(method, params = []) {
        const response = await fetch(`http://${host}:${port}/`, {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '1.0', id: nextId++, method, params })
        });
        const body = await response.json();
        if (body.error) {
            const error = new Error(`${method}: ${body.error.message}`);
            error.code = body.error.code;
            throw error;
        }
        return body.result;
    };
}

module.exports = { createRpcClient };
