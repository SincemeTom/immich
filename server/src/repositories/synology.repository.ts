import { Injectable } from '@nestjs/common';
import http from 'node:http';
import https from 'node:https';
import { SynologyError, SynologyErrorReason, getConnectionErrorReason } from 'src/utils/synology.js';

const TIMEOUT = 30_000;
/** a page of 500 items with their EXIF is about 1 MB */
const MAX_RESPONSE = 32 * 1024 * 1024;

export type SynologyConnection = { url: string; verifyCertificate: boolean };

export type SynologyResponse<T = any> = {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: unknown };
};

/**
 * The Synology Web API (`/webapi/entry.cgi`). Parameters go in a POST body, never in the URL, as the password is one
 * of them; redirects are not followed. Lists and objects are sent as JSON, as Synology's web pages send them.
 */
@Injectable()
export class SynologyRepository {
  async call<T = any>(
    connection: SynologyConnection,
    api: string,
    method: string,
    version: number,
    params: Record<string, unknown> = {},
    sid?: string,
  ): Promise<SynologyResponse<T>> {
    const body = new URLSearchParams({ api, method, version: String(version) });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        body.set(key, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
      }
    }
    if (sid) {
      body.set('_sid', sid);
    }

    const text = await this.post(new URL('/webapi/entry.cgi', connection.url), body.toString(), connection);
    let response: unknown;
    try {
      response = JSON.parse(text);
    } catch {
      throw new SynologyError(SynologyErrorReason.NotSynology, 'The answer was not JSON');
    }
    if (typeof response !== 'object' || response === null || typeof (response as any).success !== 'boolean') {
      throw new SynologyError(SynologyErrorReason.NotSynology, 'The answer was not from the Synology Web API');
    }
    return response as SynologyResponse<T>;
  }

  private post(url: URL, body: string, { verifyCertificate }: SynologyConnection) {
    return new Promise<string>((resolve, reject) => {
      const client = url.protocol === 'http:' ? http : https;
      const request = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: TIMEOUT,
          ...(url.protocol === 'https:' && { rejectUnauthorized: verifyCertificate }),
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(
              new SynologyError(SynologyErrorReason.NotSynology, `HTTP ${response.statusCode} from ${url.origin}`),
            );
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE) {
              request.destroy(new SynologyError(SynologyErrorReason.Other, 'The answer was too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          response.on('error', reject);
        },
      );
      request.on('timeout', () =>
        request.destroy(new SynologyError(SynologyErrorReason.Unreachable, `No answer within ${TIMEOUT / 1000} s`)),
      );
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (error instanceof SynologyError) {
          reject(error);
          return;
        }
        reject(new SynologyError(getConnectionErrorReason(error.code), error.message));
      });
      request.end(body);
    });
  }
}
