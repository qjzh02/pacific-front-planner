import { randomBytes } from 'node:crypto';

// 仅保存一次连接和最近请求，不持久化游戏数据或求解器输入。
export function createCaptureRelay(validateSnapshot) {
  const token = randomBytes(32).toString('hex');
  const gameOrigin = 'https://pacificfront.worldofwarships.asia';
  let clientId = null, lastSeen = 0, pending = null;
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  const connected = () => clientId !== null && Date.now() - lastSeen < 90000;

  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/capture/')) return false;
    const localOrigin = `http://127.0.0.1:${request.socket.localPort}`;
    const origin = request.headers.origin;
    const reply = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...(origin === gameOrigin ? { 'Access-Control-Allow-Origin': gameOrigin, Vary: 'Origin' } : {}) });
      response.end(JSON.stringify(data));
      return true;
    };
    if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) return reply(403, { error: '本机地址无效。' });
    const game = url.pathname === '/capture/game';
    const local = ['/capture/config', '/capture/status', '/capture/request'].includes(url.pathname);
    if (!game && !local) return reply(404, { error: '接口不存在。' });
    if ((game && origin !== gameOrigin) || (local && origin && origin !== localOrigin) ||
      (local && request.headers['sec-fetch-site'] === 'cross-site')) return reply(403, { error: '采集请求来源不匹配。' });
    if (request.method === 'OPTIONS' && game) {
      const headers = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (!['GET', 'POST'].includes(request.headers['access-control-request-method']) || headers.some(header => !['content-type', 'x-capture-token'].includes(header))) {
        return reply(403, { error: '预检请求无效。' });
      }
      response.writeHead(204, { 'Access-Control-Allow-Origin': gameOrigin, 'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-Capture-Token', 'Access-Control-Max-Age': '600',
        'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin', 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
    if (url.pathname === '/capture/config') {
      return request.method === 'GET' ? reply(200, { token }) : reply(405, { error: '请求方法无效。' });
    }
    if (request.headers['x-capture-token'] !== token) return reply(403, { error: '配对码已失效，请重新复制采集脚本。' });
    if (url.pathname === '/capture/status') {
      return request.method === 'GET' ? reply(200, { connected: connected(), clientId, result: pending?.result ?? null }) : reply(405, { error: '请求方法无效。' });
    }
    if (game && request.method === 'GET') {
      if (url.searchParams.get('client') !== clientId || !clientId) return reply(409, { error: '游戏页尚未连接或另一个游戏页已接管，请重新点击连接。' });
      lastSeen = Date.now();
      return reply(200, { requestId: pending && !pending.result ? pending.requestId : null });
    }
    if (request.method !== 'POST') return reply(405, { error: '请求方法无效。' });
    if (!request.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '数据格式无效。' });
    if (Number(request.headers['content-length']) > 16384) { request.resume(); return reply(413, { error: '采集数据过大。' }); }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 16384) { reply(413, { error: '采集数据过大。' }); request.resume(); return true; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/capture/request') {
        if (!connected()) return reply(409, { error: '游戏页未连接，请先在游戏页点击连接。' });
        if (!validId(body.requestId)) return reply(400, { error: '抓取请求编号无效。' });
        pending = { requestId: body.requestId, result: null };
        return reply(200, { requestId: body.requestId });
      }
      if (body.type === 'connect' && validId(body.clientId)) {
        clientId = body.clientId; lastSeen = Date.now(); pending = null;
        return reply(200, { connected: true });
      }
      if (body.type === 'disconnect' && body.clientId === clientId) {
        clientId = null; lastSeen = 0; pending = null;
        return reply(200, { connected: false });
      }
      if (body.type !== 'result' || body.clientId !== clientId || !connected() || body.requestId !== pending?.requestId || pending.result) {
        return reply(409, { error: '抓取请求已结束或连接已改变。' });
      }
      if (body.error !== undefined) {
        if (typeof body.error !== 'string' || !body.error.length || body.error.length > 250) return reply(400, { error: '错误说明无效。' });
        pending.result = { requestId: body.requestId, error: body.error };
      } else {
        validateSnapshot(body.snapshot);
        pending.result = { requestId: body.requestId, snapshot: body.snapshot };
      }
      lastSeen = Date.now();
      return reply(200, { received: true });
    } catch (error) { return reply(400, { error: error.message === 'Unexpected end of JSON input' ? '采集数据不完整。' : String(error.message).slice(0, 250) }); }
  };
}
