import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(UserRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(UserRepository.name, () => {
  describe('getUsage', () => {
    it("should be what the user's photos take: uploaded, and of their external libraries still there", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const newLibrary = (deletedAt: Date | null = null) =>
        ctx.database
          .insertInto('library')
          .values({ name: 'Library', ownerId: user.id, importPaths: ['/photos'], exclusionPatterns: [], deletedAt })
          .returning('id')
          .executeTakeFirstOrThrow();
      const library = await newLibrary();
      const deletedLibrary = await newLibrary(new Date());
      const newPhoto = async (size: number, dto: { ownerId?: string; libraryId?: string; deletedAt?: Date } = {}) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id, ...dto });
        await ctx.newExif({ assetId: asset.id, fileSizeInByte: size });
      };

      await newPhoto(100);
      // the quota counts the trash
      await newPhoto(20, { deletedAt: new Date() });
      await newPhoto(1000, { libraryId: library.id });
      // offline photos go to the trash; a library being deleted is going
      await newPhoto(3000, { libraryId: library.id, deletedAt: new Date() });
      await newPhoto(5000, { libraryId: deletedLibrary.id });
      await newPhoto(7, { ownerId: other.id });

      await expect(sut.getUsage(user.id)).resolves.toEqual({ uploads: 120, external: 1000 });
      await expect(sut.getUsage(other.id)).resolves.toEqual({ uploads: 7, external: 0 });
    });

    it('should be nothing for a user without photos', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      await expect(sut.getUsage(user.id)).resolves.toEqual({ uploads: 0, external: 0 });
    });
  });
});
