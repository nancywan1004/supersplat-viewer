import { createServer } from 'node:http';

const PORT = Number(process.env.PROXY_PORT ?? 3001);
const ALLOW_ORIGIN = process.env.PROXY_ALLOW_ORIGIN ?? 'http://localhost:3000';

const writeCors = (headers = {}) => ({
    ...headers,
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': '*'
});

const sendJson = (res, statusCode, body) => {
    res.writeHead(statusCode, writeCors({ 'content-type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
    if (!req.url) {
        sendJson(res, 400, { error: 'Missing request URL' });
        return;
    }

    const requestUrl = new URL(req.url, `http://localhost:${PORT}`);

    if (requestUrl.pathname === '/health') {
        sendJson(res, 200, { status: 'OK', message: 'Proxy server is running' });
        return;
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, writeCors({ 'access-control-max-age': '600' }));
        res.end();
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Only GET/HEAD are supported' });
        return;
    }

    if (requestUrl.pathname !== '/api/proxy') {
        sendJson(res, 404, { error: 'Use /api/proxy?url=<encoded target url>' });
        return;
    }

    const target = requestUrl.searchParams.get('url');
    if (!target) {
        sendJson(res, 400, { error: 'Missing url query parameter' });
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch {
        sendJson(res, 400, { error: 'Invalid target URL' });
        return;
    }

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        sendJson(res, 400, { error: 'Only http/https are supported' });
        return;
    }

    try {
        const upstream = await fetch(targetUrl, {
            method: req.method,
            headers: {
                ...(req.headers.referer ? { referer: req.headers.referer } : {}),
                ...(req.headers.origin ? { origin: req.headers.origin } : {}),
                ...(req.headers['user-agent'] ? { 'user-agent': req.headers['user-agent'] } : {})
            }
        });

        const headers = Object.fromEntries(upstream.headers.entries());
        const responseHeaders = writeCors(headers);
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];

        res.writeHead(upstream.status, responseHeaders);

        if (req.method === 'HEAD' || !upstream.body) {
            res.end();
            return;
        }

        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.end(buffer);
    } catch (error) {
        sendJson(res, 502, {
            error: 'Proxy error',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

server.listen(PORT, () => {
    console.log(`Proxy server running on http://localhost:${PORT}`);
    console.log(`Proxy endpoint: http://localhost:${PORT}/api/proxy?url=<encoded target url>`);
    console.log(`Allowed origin: ${ALLOW_ORIGIN}`);
});
