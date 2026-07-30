import http from 'node:http';

export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function startMockUpstream() {
  const state = { generationCalls: 0, modelCalls: 0 };
  const server = http.createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (request.url === '/image.png') {
      const bytes = Buffer.from(PNG_BASE64, 'base64');
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length });
      response.end(bytes);
      return;
    }
    if (request.url === '/v1/models') {
      state.modelCalls += 1;
      if (request.headers.authorization !== 'Bearer sk-test') return send(401, { error: 'bad key' });
      return send(200, { data: [{ id: 'gpt-image-1', owned_by: 'mock' }] });
    }
    if (request.url === '/v1/images/generations' && request.method === 'POST') {
      state.generationCalls += 1;
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.prompt === '401') return send(401, { error: 'bad key' });
      if (body.prompt === '429') return send(429, { error: 'limited' });
      if (body.prompt === '500') return send(500, { error: 'boom' });
      if (body.prompt === 'bad-json') return send(200, 'not-json');
      if (body.prompt === 'timeout') {
        setTimeout(() => send(200, { data: [{ b64_json: PNG_BASE64 }] }), 200);
        return;
      }
      if (body.prompt === 'url') return send(200, { data: [{ url: `${server.baseUrl}/image.png` }] });
      if (body.prompt === 'multi') return send(200, { data: [{ b64_json: PNG_BASE64 }, { url: `${server.baseUrl}/image.png` }] });
      return send(200, { data: [{ b64_json: PNG_BASE64 }] });
    }
    send(404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  server.baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    state,
    baseUrl: server.baseUrl,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
