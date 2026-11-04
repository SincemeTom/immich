import request from 'supertest';
import { SynologyController } from 'src/controllers/synology.controller.js';
import { SynologyService } from 'src/services/synology.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(SynologyController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(SynologyService);

  beforeAll(async () => {
    ctx = await controllerSetup(SynologyController, [{ provide: SynologyService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /synology/account', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/synology/account');
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('GET /synology/account/unmatched', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/synology/account/unmatched');
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('PUT /synology/account', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).put('/synology/account').send({});
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should check the certificate unless told not to', async () => {
      service.bindAccount.mockResolvedValue({ success: true, account: { bound: true } });

      const { status } = await request(ctx.getHttpServer())
        .put('/synology/account')
        .send({ url: 'nas.example.com:5001', account: ' alice ', password: 'pw' });

      expect(status).toBe(200);
      expect(service.bindAccount).toHaveBeenCalledWith(undefined, {
        url: 'nas.example.com:5001',
        account: 'alice',
        password: 'pw',
        verifyCertificate: true,
      });
    });

    it.each([
      [{ account: 'alice', password: 'pw' }, 'url'],
      [{ url: 'ftp://nas', account: 'alice', password: 'pw' }, 'url'],
      [{ url: 'nas', account: '  ', password: 'pw' }, 'account'],
      [{ url: 'nas', account: 'alice', password: '' }, 'password'],
      [{ url: 'nas', account: 'alice', password: 'pw', otpCode: '12ab56' }, 'otpCode'],
      [{ url: 'nas', account: 'alice', password: 'pw', verifyCertificate: 'no' }, 'verifyCertificate'],
    ])('should refuse %j', async (body, path) => {
      const { status, body: response } = await request(ctx.getHttpServer()).put('/synology/account').send(body);

      expect(status).toBe(400);
      expect(JSON.stringify(response)).toContain(path);
      expect(service.bindAccount).not.toHaveBeenCalled();
    });
  });

  describe('POST /synology/account/test', () => {
    it('should answer 200', async () => {
      service.testAccount.mockResolvedValue({ success: true, account: { bound: true } });

      const { status } = await request(ctx.getHttpServer()).post('/synology/account/test');

      expect(ctx.authenticate).toHaveBeenCalled();
      expect(status).toBe(200);
    });
  });

  describe('POST /synology/account/sync', () => {
    it('should answer 200', async () => {
      service.syncAccount.mockResolvedValue({ bound: true, syncPending: true });

      const { status } = await request(ctx.getHttpServer()).post('/synology/account/sync');

      expect(ctx.authenticate).toHaveBeenCalled();
      expect(status).toBe(200);
    });
  });

  describe('PUT /synology/account/schedule', () => {
    it('should take a time of day', async () => {
      service.updateSchedule.mockResolvedValue({ bound: true });

      const { status } = await request(ctx.getHttpServer())
        .put('/synology/account/schedule')
        .send({ autoSync: true, syncTime: ' 04:30 ' });

      expect(ctx.authenticate).toHaveBeenCalled();
      expect(status).toBe(200);
      expect(service.updateSchedule).toHaveBeenCalledWith(undefined, { autoSync: true, syncTime: '04:30' });
    });

    it.each([
      [{ autoSync: true }, 'syncTime'],
      [{ autoSync: true, syncTime: '4:30' }, 'syncTime'],
      [{ autoSync: true, syncTime: '24:00' }, 'syncTime'],
      [{ syncTime: '03:00' }, 'autoSync'],
    ])('should refuse %j', async (body, path) => {
      const { status, body: response } = await request(ctx.getHttpServer())
        .put('/synology/account/schedule')
        .send(body);

      expect(status).toBe(400);
      expect(JSON.stringify(response)).toContain(path);
    });
  });

  describe('DELETE /synology/account', () => {
    it('should answer 204', async () => {
      const { status } = await request(ctx.getHttpServer()).delete('/synology/account');

      expect(ctx.authenticate).toHaveBeenCalled();
      expect(status).toBe(204);
    });
  });
});
