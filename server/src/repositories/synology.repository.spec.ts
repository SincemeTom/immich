import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SynologyRepository } from 'src/repositories/synology.repository.js';
import { SynologyError, SynologyErrorReason } from 'src/utils/synology.js';

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

describe(SynologyRepository.name, () => {
  let sut: SynologyRepository;
  let server: Server;
  let url: string;
  let handler: Handler;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => handler(request, body, response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    sut = new SynologyRepository();
    handler = (_request, _body, response) => response.end(JSON.stringify({ success: true, data: {} }));
  });

  it('should POST the parameters as a form, never in the URL', async () => {
    let seen: { method?: string; url?: string; type?: string; body: string } = { body: '' };
    handler = (request, body, response) => {
      seen = { method: request.method, url: request.url, type: request.headers['content-type'], body };
      response.end(JSON.stringify({ success: true, data: { sid: 'sid-1' } }));
    };

    const result = await sut.call(
      { url, verifyCertificate: true },
      'SYNO.API.Auth',
      'login',
      7,
      { account: 'alice', passwd: 'p&ss=w0rd 中', otp_code: undefined, additional: ['thumbnail'], limit: 500 },
      'sid-0',
    );

    expect(result).toEqual({ success: true, data: { sid: 'sid-1' } });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/webapi/entry.cgi');
    expect(seen.type).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(seen.body))).toEqual({
      api: 'SYNO.API.Auth',
      method: 'login',
      version: '7',
      account: 'alice',
      passwd: 'p&ss=w0rd 中',
      additional: '["thumbnail"]',
      limit: '500',
      _sid: 'sid-0',
    });
  });

  it('should give Synology errors as they are', async () => {
    handler = (_request, _body, response) => response.end(JSON.stringify({ success: false, error: { code: 400 } }));

    await expect(sut.call({ url, verifyCertificate: true }, 'SYNO.API.Auth', 'login', 7)).resolves.toEqual({
      success: false,
      error: { code: 400 },
    });
  });

  it.each([
    ['not JSON', (response: ServerResponse) => response.end('<html></html>')],
    ['JSON, but not the Web API', (response: ServerResponse) => response.end('{"hello":"world"}')],
    [
      'not HTTP 200',
      (response: ServerResponse) => {
        response.statusCode = 404;
        response.end('Not found');
      },
    ],
    [
      'a redirect',
      (response: ServerResponse) => {
        response.writeHead(302, { Location: 'https://example.com/' });
        response.end();
      },
    ],
  ])('should tell it is not a Synology for %s', async (_name, reply) => {
    handler = (_request, _body, response) => reply(response);

    const error = await sut
      .call({ url, verifyCertificate: true }, 'SYNO.API.Info', 'query', 1)
      .catch((error_) => error_);

    expect(error).toBeInstanceOf(SynologyError);
    expect(error.reason).toBe(SynologyErrorReason.NotSynology);
  });

  it('should tell nothing answered', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    const error = await sut
      .call({ url: `http://127.0.0.1:${port}`, verifyCertificate: true }, 'SYNO.API.Info', 'query', 1)
      .catch((error_) => error_);

    expect(error).toBeInstanceOf(SynologyError);
    expect(error.reason).toBe(SynologyErrorReason.Unreachable);
  });

  it('should tell when HTTPS is spoken to an HTTP port', async () => {
    const error = await sut
      .call({ url: url.replace('http:', 'https:'), verifyCertificate: true }, 'SYNO.API.Info', 'query', 1)
      .catch((error_) => error_);

    expect(error).toBeInstanceOf(SynologyError);
    expect(error.reason).toBe(SynologyErrorReason.NotSynology);
  });
});
