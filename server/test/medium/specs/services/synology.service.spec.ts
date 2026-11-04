import { Kysely } from 'kysely';
import type { SynologyResponse } from 'src/repositories/synology.repository.js';
import type { SynologyAccount } from 'src/types.js';
import { AssetVisibility, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { KeychainRepository } from 'src/repositories/keychain.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SynologyAlbumRepository } from 'src/repositories/synology-album.repository.js';
import { SynologyRepository } from 'src/repositories/synology.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { SynologyService } from 'src/services/synology.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const url = 'https://nas.example.com:5001';
const ok = <T>(data: T): SynologyResponse<T> => ({ success: true, data });

type Album = { id: number; name: string; cover?: number; items: Item[] };
type Item = { id: number; filename: string; folder: number; filesize?: number; owner?: number };

const setup = () => {
  const { sut, ctx } = newMediumService(SynologyService, {
    database: defaultDatabase,
    real: [AlbumRepository, AssetJobRepository, SynologyAlbumRepository, SystemMetadataRepository, UserRepository],
    mock: [ConfigRepository, EventRepository, JobRepository, KeychainRepository, LoggingRepository, SynologyRepository],
  });

  ctx
    .getMock(ConfigRepository)
    .getEnv.mockReturnValue(
      mockEnvData({ storage: { ignoreMountCheckErrors: false, networkSharesLocation: '/tmp/immich-mounts' } }),
    );
  ctx.getMock(KeychainRepository).get.mockResolvedValue(JSON.stringify({ password: 'pw' }));
  ctx.getMock(KeychainRepository).set.mockResolvedValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();

  /** what Synology has: its albums, and its folders by ID */
  const synology = { albums: [] as Album[], folders: { 1: '/2023/Trip', 2: '/2024' } as Record<number, string> };
  ctx.getMock(SynologyRepository).call.mockImplementation((_connection, api, method, _version, params = {}) => {
    const reply = (() => {
      switch (`${api} ${method}`) {
        case 'SYNO.API.Info query': {
          return ok({ 'SYNO.API.Auth': { maxVersion: 7 }, 'SYNO.Foto.Browse.Album': {}, 'SYNO.Foto.UserInfo': {} });
        }
        case 'SYNO.API.Auth login': {
          return ok({ sid: 'sid' });
        }
        case 'SYNO.API.Auth logout': {
          return ok({});
        }
        case 'SYNO.Foto.UserInfo me': {
          return ok({ id: 1, name: 'me' });
        }
        case 'SYNO.Foto.Browse.Album list': {
          return ok({
            list: synology.albums.map(({ id, name, cover }) => ({
              id,
              name,
              owner_user_id: 1,
              additional: { thumbnail: { unit_id: cover } },
            })),
          });
        }
        case 'SYNO.Foto.Browse.Item list': {
          const album = synology.albums.find(({ id }) => id === params.album_id);
          const list = (album?.items ?? []).map(({ id, filename, folder, filesize, owner }) => ({
            id,
            filename,
            folder_id: folder,
            filesize,
            owner_user_id: owner ?? 1,
          }));
          return ok({ list: list.slice(Number(params.offset), Number(params.offset) + Number(params.limit)) });
        }
        case 'SYNO.Foto.Browse.Folder get': {
          const name = synology.folders[params.id as number];
          return name ? ok({ folder: { name } }) : { success: false, error: { code: 642 } };
        }
      }
      throw new Error(`unexpected call ${api} ${method}`);
    })();
    return Promise.resolve(reply);
  });

  return { sut, ctx, synology };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

type Context = ReturnType<typeof setup>['ctx'];

const newAccount = async (ctx: Context) => {
  const { user } = await ctx.newUser();
  const library = await ctx.get(LibraryRepository).create({
    name: 'NAS',
    ownerId: user.id,
    importPaths: ['/mnt/nas/home/Photos'],
    exclusionPatterns: [],
  });
  const account: SynologyAccount = {
    url,
    verifyCertificate: true,
    account: 'me',
    photosUserId: 1,
    boundAt: '2026-11-01T00:00:00.000Z',
    checkedAt: '2026-11-01T00:00:00.000Z',
  };
  const metadata = ctx.get(SystemMetadataRepository);
  const current = await metadata.get(SystemMetadataKey.SynologyAccounts);
  await metadata.set(SystemMetadataKey.SynologyAccounts, { users: { ...current?.users, [user.id]: account } });

  const newPhoto = async (path: string, fileSizeInByte = 100) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      libraryId: library.id,
      isExternal: true,
      originalPath: `/mnt/nas/home/Photos/${path}`,
    });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte });
    return asset;
  };

  return { user, library, newPhoto };
};

const getAlbums = (ctx: Context, userId: string) =>
  ctx.database
    .selectFrom('album')
    .innerJoin('synology_album', 'synology_album.albumId', 'album.id')
    .select(['album.id', 'album.albumName', 'album.albumThumbnailAssetId', 'synology_album.synologyAlbumId'])
    .where('synology_album.userId', '=', userId)
    .orderBy('synology_album.synologyAlbumId')
    .execute();

const getAssetIds = async (ctx: Context, albumId: string) => {
  const rows = await ctx.database.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute();
  return rows.map(({ assetId }) => assetId).toSorted();
};

const getReport = async (ctx: Context, userId: string) => {
  const value = await ctx.get(SystemMetadataRepository).get(SystemMetadataKey.SynologyAccounts);
  return value!.users[userId].lastSync!;
};

describe(SynologyService.name, () => {
  it('should create an album of the photos found in the external library', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    const a = await newPhoto('2023/Trip/a.jpg');
    const b = await newPhoto('2023/Trip/b.heic');
    await newPhoto('2023/Trip/c.jpg');
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        cover: 11,
        items: [
          { id: 10, filename: 'a.jpg', folder: 1, filesize: 100 },
          { id: 11, filename: 'b.heic', folder: 1, filesize: 100 },
          { id: 12, filename: 'gone.jpg', folder: 1 },
          { id: 13, filename: 'theirs.jpg', folder: 1, owner: 2 },
        ],
      },
    ];

    await expect(sut.handleAlbumSync({ id: user.id })).resolves.toBe(JobStatus.Success);

    const albums = await getAlbums(ctx, user.id);
    expect(albums).toEqual([
      { id: expect.any(String), albumName: 'Trip', albumThumbnailAssetId: b.id, synologyAlbumId: 7 },
    ]);
    await expect(getAssetIds(ctx, albums[0].id)).resolves.toEqual([a.id, b.id].toSorted());
    await expect(getReport(ctx, user.id)).resolves.toEqual(
      expect.objectContaining({
        success: true,
        albums: 1,
        albumsCreated: 1,
        items: 3,
        matched: 2,
        others: 1,
        added: 2,
        unmatchedPaths: ['2023/Trip/gone.jpg'],
      }),
    );
  });

  it('should not create an album none of whose photos are found', async () => {
    const { sut, ctx, synology } = setup();
    const { user } = await newAccount(ctx);
    synology.albums = [{ id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] }];

    await sut.handleAlbumSync({ id: user.id });

    await expect(getAlbums(ctx, user.id)).resolves.toEqual([]);
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ albumsEmpty: 1 }));
  });

  it('should not take photos of another user, nor in the trash, nor the video of a live photo', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    const { library: other, user: otherUser } = await newAccount(ctx);
    await ctx.newAsset({
      ownerId: otherUser.id,
      libraryId: other.id,
      isExternal: true,
      originalPath: '/mnt/nas/home/Photos/2023/Trip/a.jpg',
    });
    const trashed = await newPhoto('2023/Trip/b.jpg');
    await ctx.database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', trashed.id).execute();
    const video = await newPhoto('2023/Trip/c.mov');
    await ctx.database
      .updateTable('asset')
      .set({ visibility: AssetVisibility.Hidden })
      .where('id', '=', video.id)
      .execute();
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          { id: 11, filename: 'b.jpg', folder: 1 },
          { id: 12, filename: 'c.mov', folder: 1 },
        ],
      },
    ];

    await sut.handleAlbumSync({ id: user.id });

    await expect(getAlbums(ctx, user.id)).resolves.toEqual([]);
  });

  it('should follow Synology: rename, change the cover, add and remove the photos it added', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    const b = await newPhoto('2023/Trip/b.jpg');
    const c = await newPhoto('2024/c.jpg');
    const mine = await newPhoto('2024/mine.jpg');
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        cover: 10,
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          { id: 11, filename: 'b.jpg', folder: 1 },
        ],
      },
    ];
    await sut.handleAlbumSync({ id: user.id });
    const [album] = await getAlbums(ctx, user.id);
    // the user adds a photo of their own, and takes one out
    await ctx.get(AlbumRepository).addAssetIds(album.id, [mine.id]);
    await ctx.get(AlbumRepository).removeAssetIds(album.id, [b.id]);

    synology.albums = [
      {
        id: 7,
        name: 'Trip 2023',
        cover: 12,
        items: [
          { id: 11, filename: 'b.jpg', folder: 1 },
          { id: 12, filename: 'c.jpg', folder: 2 },
        ],
      },
    ];
    await sut.handleAlbumSync({ id: user.id });

    await expect(getAlbums(ctx, user.id)).resolves.toEqual([
      { id: album.id, albumName: 'Trip 2023', albumThumbnailAssetId: c.id, synologyAlbumId: 7 },
    ]);
    await expect(getAssetIds(ctx, album.id)).resolves.toEqual([b.id, c.id, mine.id].toSorted());
    await expect(ctx.get(SynologyAlbumRepository).getAssetIds(album.id)).resolves.toEqual(new Set([b.id, c.id]));
    await expect(getReport(ctx, user.id)).resolves.toEqual(
      expect.objectContaining({ albumsUpdated: 1, added: 2, removed: 1 }),
    );
  });

  it('should keep a name the user gave the album, until Synology renames it', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    synology.albums = [{ id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] }];
    await sut.handleAlbumSync({ id: user.id });
    const [album] = await getAlbums(ctx, user.id);
    await ctx.get(AlbumRepository).update(album.id, { albumName: 'Mine' }, user.id);

    await sut.handleAlbumSync({ id: user.id });

    const [after] = await getAlbums(ctx, user.id);
    expect(after.albumName).toBe('Mine');
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ albumsUpdated: 0 }));
  });

  it('should remove an album Synology no longer has, not its photos', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    const a = await newPhoto('2023/Trip/a.jpg');
    await newPhoto('2024/b.jpg');
    synology.albums = [
      { id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] },
      { id: 8, name: '2024', items: [{ id: 11, filename: 'b.jpg', folder: 2 }] },
    ];
    await sut.handleAlbumSync({ id: user.id });
    const { album: own } = await ctx.newAlbum({ ownerId: user.id }, [a.id]);

    synology.albums = [synology.albums[1]];
    await sut.handleAlbumSync({ id: user.id });

    const albums = await getAlbums(ctx, user.id);
    expect(albums.map(({ synologyAlbumId }) => synologyAlbumId)).toEqual([8]);
    await expect(ctx.database.selectFrom('asset').select('id').where('id', '=', a.id).execute()).resolves.toHaveLength(
      1,
    );
    await expect(getAssetIds(ctx, own.id)).resolves.toEqual([a.id]);
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ albumsRemoved: 1 }));
  });

  it('should leave the albums of an account bound before', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    synology.albums = [{ id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] }];
    await sut.handleAlbumSync({ id: user.id });

    const metadata = ctx.get(SystemMetadataRepository);
    const value = await metadata.get(SystemMetadataKey.SynologyAccounts);
    value!.users[user.id].photosUserId = 5;
    await metadata.set(SystemMetadataKey.SynologyAccounts, value!);
    synology.albums = [];
    await sut.handleAlbumSync({ id: user.id });

    await expect(getAlbums(ctx, user.id)).resolves.toHaveLength(1);
  });

  it('should leave an album whose photos Synology does not list', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    synology.albums = [{ id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] }];
    await sut.handleAlbumSync({ id: user.id });

    const call = ctx.getMock(SynologyRepository).call.getMockImplementation()!;
    ctx
      .getMock(SynologyRepository)
      .call.mockImplementation((connection, api, method, ...rest) =>
        api === 'SYNO.Foto.Browse.Item'
          ? Promise.resolve({ success: false, error: { code: 120 } })
          : call(connection, api, method, ...rest),
      );
    await sut.handleAlbumSync({ id: user.id });

    const [album] = await getAlbums(ctx, user.id);
    await expect(getAssetIds(ctx, album.id)).resolves.toHaveLength(1);
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ albumsFailed: 1, removed: 0 }));
  });

  it('should forget the albums with the user', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    synology.albums = [{ id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] }];
    await sut.handleAlbumSync({ id: user.id });

    await ctx.get(UserRepository).delete({ id: user.id }, true);

    await expect(
      ctx.database.selectFrom('synology_album').selectAll().where('userId', '=', user.id).execute(),
    ).resolves.toEqual([]);
  });
});
