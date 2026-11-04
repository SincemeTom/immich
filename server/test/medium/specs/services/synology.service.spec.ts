import { Kysely } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SynologyResponse } from 'src/repositories/synology.repository.js';
import type { SynologyAccount } from 'src/types.js';
import { AlbumUserRole, AssetVisibility, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
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

type Member = { id: number; name: string; role: string };
type Album = { id: number; name: string; cover?: number; items: Item[]; members?: Member[] };
type Item = { id: number; filename: string; folder: number; filesize?: number; owner?: number; time?: number };

const sidOf = (account: string) => `sid-${account}`;

const setup = () => {
  const { sut, ctx } = newMediumService(SynologyService, {
    database: defaultDatabase,
    real: [
      AlbumRepository,
      AlbumUserRepository,
      AssetJobRepository,
      SynologyAlbumRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
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

  /** what Synology has: its albums, its folders by ID and whose they are, its accounts and their Photos user IDs */
  const synology = {
    albums: [] as Album[],
    folders: { 1: ['me', '/2023/Trip'], 2: ['me', '/2024'] } as Record<number, [string, string]>,
    users: { me: 1 } as Record<string, number>,
    failLogin: new Set<string>(),
  };
  ctx.getMock(SynologyRepository).call.mockImplementation((_connection, api, method, _version, params = {}, sid) => {
    const reply = (() => {
      switch (`${api} ${method}`) {
        case 'SYNO.API.Info query': {
          return ok({ 'SYNO.API.Auth': { maxVersion: 7 }, 'SYNO.Foto.Browse.Album': {}, 'SYNO.Foto.UserInfo': {} });
        }
        case 'SYNO.API.Auth login': {
          const account = params.account as string;
          return synology.failLogin.has(account)
            ? { success: false, error: { code: 400 } }
            : ok({ sid: sidOf(account) });
        }
        case 'SYNO.API.Auth logout': {
          return ok({});
        }
        case 'SYNO.Foto.UserInfo me': {
          const account = Object.keys(synology.users).find((name) => sidOf(name) === sid);
          return ok({ id: synology.users[account!], name: account });
        }
        case 'SYNO.Foto.Browse.Album list': {
          return ok({
            list: synology.albums.map(({ id, name, cover, members = [] }) => ({
              id,
              name,
              owner_user_id: 1,
              shared: members.length > 0,
              additional: {
                thumbnail: { unit_id: cover },
                sharing_info: {
                  permission: members.map(({ id, name, role }) => ({
                    db_id: id,
                    id: 1000 + id,
                    name,
                    role,
                    type: 'user',
                  })),
                },
              },
            })),
          });
        }
        case 'SYNO.Foto.Browse.Item list': {
          const album = synology.albums.find(({ id }) => id === params.album_id);
          const list = (album?.items ?? []).map(({ id, filename, folder, filesize, owner, time }) => ({
            id,
            filename,
            folder_id: folder,
            filesize,
            owner_user_id: owner ?? 1,
            time,
          }));
          return ok({ list: list.slice(Number(params.offset), Number(params.offset) + Number(params.limit)) });
        }
        case 'SYNO.Foto.Browse.Folder get': {
          const [owner, name] = synology.folders[params.id as number] ?? [];
          return name && sid === sidOf(owner) ? ok({ folder: { name } }) : { success: false, error: { code: 642 } };
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

/** A user with an external library of their Synology Photos folder: bound to a Synology account unless told not */
const newAccount = async (
  ctx: Context,
  { account = 'me', photosUserId = 1, bound = true, oauthId = null as string | null } = {},
) => {
  const { user } = await ctx.newUser({ oauthId });
  const library = await ctx.get(LibraryRepository).create({
    name: 'NAS',
    ownerId: user.id,
    importPaths: [`/mnt/nas/${account}/Photos`],
    exclusionPatterns: [],
  });
  if (bound) {
    const value: SynologyAccount = {
      url,
      verifyCertificate: true,
      account,
      photosUserId,
      boundAt: '2026-11-01T00:00:00.000Z',
      checkedAt: '2026-11-01T00:00:00.000Z',
    };
    const metadata = ctx.get(SystemMetadataRepository);
    const current = await metadata.get(SystemMetadataKey.SynologyAccounts);
    await metadata.set(SystemMetadataKey.SynologyAccounts, { users: { ...current?.users, [user.id]: value } });
  }

  const newPhoto = async (path: string, fileSizeInByte = 100, localDateTime = new Date('2023-05-01T10:00:00.000Z')) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      libraryId: library.id,
      isExternal: true,
      originalPath: `/mnt/nas/${account}/Photos/${path}`,
      originalFileName: path.split('/').pop(),
      localDateTime,
    });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte });
    return asset;
  };

  return { user, library, newPhoto };
};

const getMembers = (ctx: Context, albumId: string) =>
  ctx.database
    .selectFrom('album_user')
    .select(['userId', 'role', 'allowDownload'])
    .where('albumId', '=', albumId)
    .where('role', '!=', AlbumUserRole.Owner)
    .orderBy('userId')
    .execute();

/** the time Synology gives the photos of the tests: their local time, encoded as UTC, in seconds */
const at = new Date('2023-05-01T10:00:00.000Z').getTime() / 1000;

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

const getUnmatched = (ctx: Context, userId: string) =>
  ctx.database
    .selectFrom('synology_unmatched')
    .select(['synologyAlbumId', 'reason', 'path', 'mine'])
    .where('userId', '=', userId)
    .execute();

/** an album of one photo, shared with these members */
const album7 = (members: Member[]): Album => ({
  id: 7,
  name: 'Trip',
  items: [{ id: 10, filename: 'a.jpg', folder: 1 }],
  members,
});

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
        unmatched: 2,
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

  it('should share the album as Synology does, with the members found in Immich', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    const { user: bob } = await newAccount(ctx, { account: 'bob11', photosUserId: 11 });
    const { user: carol } = await newAccount(ctx, { account: 'carol12', bound: false, oauthId: 'Carol12' });
    // only by a bound account or Synology SSO: not by name
    await ctx.newUser({ name: 'dave13', email: 'dave13@example.com' });
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [{ id: 10, filename: 'a.jpg', folder: 1 }],
        members: [
          { id: 11, name: 'someone', role: 'upload' },
          { id: 12, name: 'carol12', role: 'download' },
          { id: 13, name: 'dave13', role: 'view' },
        ],
      },
    ];

    await sut.handleAlbumSync({ id: user.id });

    const [album] = await getAlbums(ctx, user.id);
    await expect(getMembers(ctx, album.id)).resolves.toEqual(
      [
        { userId: bob.id, role: AlbumUserRole.Editor, allowDownload: true },
        { userId: carol.id, role: AlbumUserRole.Viewer, allowDownload: true },
      ].toSorted((a, b) => a.userId.localeCompare(b.userId)),
    );
    await expect(getReport(ctx, user.id)).resolves.toEqual(
      expect.objectContaining({ membersAdded: 2, membersWaiting: 1 }),
    );
  });

  it("should follow Synology's sharing, and leave the members shared with by hand", async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    const { user: bob } = await newAccount(ctx, { account: 'bob21', photosUserId: 21 });
    const { user: carol } = await newAccount(ctx, { account: 'carol22', photosUserId: 22 });
    const { user: eve } = await ctx.newUser();
    synology.albums = [
      album7([
        { id: 21, name: 'bob21', role: 'upload' },
        { id: 22, name: 'carol22', role: 'view' },
      ]),
    ];
    await sut.handleAlbumSync({ id: user.id });
    const [album] = await getAlbums(ctx, user.id);
    // the owner shares with eve, and takes carol out
    await ctx.get(AlbumUserRepository).create({ albumId: album.id, userId: eve.id, role: AlbumUserRole.Viewer });
    await ctx.get(AlbumUserRepository).delete({ albumId: album.id, userId: carol.id });

    synology.albums = [
      album7([
        { id: 21, name: 'bob21', role: 'view' },
        { id: 22, name: 'carol22', role: 'download' },
      ]),
    ];
    await sut.handleAlbumSync({ id: user.id });

    const members = await getMembers(ctx, album.id);
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: bob.id, role: AlbumUserRole.Viewer, allowDownload: false },
        { userId: eve.id, role: AlbumUserRole.Viewer, allowDownload: false },
      ]),
    );
    expect(members.map(({ userId }) => userId)).not.toContain(carol.id);
    await expect(getReport(ctx, user.id)).resolves.toEqual(
      expect.objectContaining({ membersAdded: 0, membersUpdated: 1, albumsUpdated: 1 }),
    );

    synology.albums = [album7([])];
    await sut.handleAlbumSync({ id: user.id });

    await expect(getMembers(ctx, album.id)).resolves.toEqual([
      { userId: eve.id, role: AlbumUserRole.Viewer, allowDownload: false },
    ]);
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ membersRemoved: 1 }));
  });

  it('should add the photos others added, from their own libraries only', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    const mine = await newPhoto('2023/Trip/a.jpg');
    const bob = await newAccount(ctx, { account: 'bob31', photosUserId: 31 });
    const carol = await newAccount(ctx, { account: 'carol32', bound: false, oauthId: 'carol32' });
    synology.users.bob31 = 31;
    synology.folders[50] = ['bob31', '/2022'];
    synology.folders[51] = ['carol32', '/Phone'];
    const bobs = await bob.newPhoto('2022/x.jpg', 300);
    await bob.newPhoto('2021/x.jpg', 300);
    const carols = await carol.newPhoto('Phone/y.jpg', 200);
    await carol.newPhoto('Other/y.jpg', 200, new Date('2023-05-01T10:00:05.000Z'));
    // the same name, size and time in someone else's library: not taken
    await newPhoto('elsewhere/z.jpg', 400);
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          { id: 11, filename: 'x.jpg', folder: 50, filesize: 300, owner: 31, time: at },
          { id: 12, filename: 'Y.JPG', folder: 51, filesize: 200, owner: 32, time: at + 1 },
          { id: 13, filename: 'z.jpg', folder: 52, filesize: 400, owner: 33, time: at },
        ],
        members: [
          { id: 31, name: 'bob31', role: 'upload' },
          { id: 32, name: 'carol32', role: 'upload' },
          { id: 33, name: 'dave33', role: 'upload' },
        ],
      },
    ];

    await sut.handleAlbumSync({ id: user.id });

    const [album] = await getAlbums(ctx, user.id);
    await expect(getAssetIds(ctx, album.id)).resolves.toEqual([mine.id, bobs.id, carols.id].toSorted());
    await expect(getReport(ctx, user.id)).resolves.toEqual(
      expect.objectContaining({
        items: 1,
        matched: 1,
        others: 3,
        othersMatched: 2,
        othersWaiting: 1,
        added: 3,
        membersWaiting: 1,
      }),
    );

    synology.albums[0].items = synology.albums[0].items.filter(({ id }) => id !== 12);
    await sut.handleAlbumSync({ id: user.id });

    await expect(getAssetIds(ctx, album.id)).resolves.toEqual([mine.id, bobs.id].toSorted());
  });

  it("should find a bound member's photo by name, size and time when their folder cannot be read", async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    const bob = await newAccount(ctx, { account: 'bob41', photosUserId: 41 });
    synology.users.bob41 = 41;
    const bobs = await bob.newPhoto('Uploads/x.jpg', 300);
    const copy = await bob.newPhoto('Uploads/2023/x.jpg', 300);
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          { id: 11, filename: 'x.jpg', folder: 60, filesize: 300, owner: 41, time: at },
        ],
        members: [{ id: 41, name: 'bob41', role: 'upload' }],
      },
    ];

    await sut.handleAlbumSync({ id: user.id });

    const [album] = await getAlbums(ctx, user.id);
    const assetIds = await getAssetIds(ctx, album.id);
    expect(assetIds).toContain(bobs.id);
    expect(assetIds).not.toContain(copy.id);
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ othersMatched: 1, ambiguous: 1 }));
  });

  it("should keep a member's photos when their account cannot log in", async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    const bob = await newAccount(ctx, { account: 'bob51', photosUserId: 51 });
    synology.users.bob51 = 51;
    synology.folders[70] = ['bob51', '/2022'];
    const bobs = await bob.newPhoto('2022/x.jpg', 300);
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          // a time that does not match: only its path finds it
          { id: 11, filename: 'x.jpg', folder: 70, filesize: 300, owner: 51, time: at + 3600 },
        ],
        members: [{ id: 51, name: 'bob51', role: 'upload' }],
      },
    ];
    await sut.handleAlbumSync({ id: user.id });
    const [album] = await getAlbums(ctx, user.id);
    await expect(getAssetIds(ctx, album.id)).resolves.toContain(bobs.id);

    synology.failLogin.add('bob51');
    await expect(sut.handleAlbumSync({ id: user.id })).resolves.toBe(JobStatus.Success);

    await expect(getAssetIds(ctx, album.id)).resolves.toContain(bobs.id);
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ othersMatched: 0, removed: 0 }));
  });

  it('should not take a photo in the locked folder', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    const locked = await newPhoto('2023/Trip/a.jpg');
    await ctx.database
      .updateTable('asset')
      .set({ visibility: AssetVisibility.Locked })
      .where('id', '=', locked.id)
      .execute();
    synology.albums = [{ id: 7, name: 'Trip', items: [{ id: 10, filename: 'a.jpg', folder: 1 }] }];

    await sut.handleAlbumSync({ id: user.id });

    await expect(getAlbums(ctx, user.id)).resolves.toEqual([]);
  });

  it("should find the account's own photo by name, size and time when its path is not found", async () => {
    const { sut, ctx, synology } = setup();
    const { user } = await newAccount(ctx);
    const uploaded = await ctx.newAsset({
      ownerId: user.id,
      originalPath: '/data/upload/x/IMG_1.jpg',
      originalFileName: 'IMG_1.jpg',
      localDateTime: new Date('2023-05-01T10:00:00.000Z'),
    });
    await ctx.newExif({ assetId: uploaded.asset.id, fileSizeInByte: 300 });
    const other = await ctx.newAsset({
      ownerId: user.id,
      originalPath: '/data/upload/x/IMG_2.jpg',
      originalFileName: 'IMG_2.jpg',
      localDateTime: new Date('2023-05-01T10:00:00.000Z'),
    });
    await ctx.newExif({ assetId: other.asset.id, fileSizeInByte: 300 });
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'IMG_1.jpg', folder: 1, filesize: 300, time: at },
          // without its size and time, a name is not enough
          { id: 11, filename: 'IMG_2.jpg', folder: 1 },
        ],
      },
    ];

    await sut.handleAlbumSync({ id: user.id });

    const [album] = await getAlbums(ctx, user.id);
    await expect(getAssetIds(ctx, album.id)).resolves.toEqual([uploaded.asset.id]);
    await expect(getReport(ctx, user.id)).resolves.toEqual(
      expect.objectContaining({ items: 2, matched: 1, matchedByName: 1, unmatched: 1 }),
    );
    await expect(getUnmatched(ctx, user.id)).resolves.toEqual([
      { synologyAlbumId: 7, reason: 'notFound', path: '2023/Trip/IMG_2.jpg', mine: true },
    ]);
  });

  it('should list the albums and photos it did not match, anew each sync', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          { id: 11, filename: 'gone.jpg', folder: 1 },
          { id: 12, filename: 'x.jpg', folder: 50, owner: 99 },
        ],
      },
      { id: 8, name: 'Empty', items: [{ id: 20, filename: 'none.jpg', folder: 2 }] },
      { id: 9, name: 'Broken', items: [{ id: 30, filename: 'a.jpg', folder: 1 }] },
    ];
    const call = ctx.getMock(SynologyRepository).call.getMockImplementation()!;
    ctx
      .getMock(SynologyRepository)
      .call.mockImplementation((connection, api, method, version, params, ...rest) =>
        api === 'SYNO.Foto.Browse.Item' && params?.album_id === 9
          ? Promise.resolve({ success: false, error: { code: 120 } })
          : call(connection, api, method, version, params, ...rest),
      );

    await sut.handleAlbumSync({ id: user.id });

    const unmatched = await getUnmatched(ctx, user.id);
    expect(unmatched).toHaveLength(5);
    expect(unmatched).toEqual(
      expect.arrayContaining([
        { synologyAlbumId: 7, reason: 'notFound', path: '2023/Trip/gone.jpg', mine: true },
        { synologyAlbumId: 7, reason: 'ownerWaiting', path: 'x.jpg', mine: false },
        { synologyAlbumId: 8, reason: 'albumEmpty', path: null, mine: true },
        { synologyAlbumId: 8, reason: 'notFound', path: '2024/none.jpg', mine: true },
        { synologyAlbumId: 9, reason: 'albumFailed', path: null, mine: true },
      ]),
    );
    await expect(getReport(ctx, user.id)).resolves.toEqual(expect.objectContaining({ unmatched: 5 }));
    const auth = { user: { id: user.id } } as AuthDto;
    await expect(sut.getUnmatched(auth)).resolves.toHaveLength(5);

    synology.albums = synology.albums.slice(0, 1);
    synology.albums[0].items = synology.albums[0].items.slice(0, 2);
    await sut.handleAlbumSync({ id: user.id });

    await expect(getUnmatched(ctx, user.id)).resolves.toEqual([
      { synologyAlbumId: 7, reason: 'notFound', path: '2023/Trip/gone.jpg', mine: true },
    ]);

    synology.failLogin.add('me');
    await sut.handleAlbumSync({ id: user.id });

    await expect(getUnmatched(ctx, user.id)).resolves.toEqual([]);
    await expect(sut.getUnmatched(auth)).resolves.toEqual([]);
  });

  it('should forget the albums with the user', async () => {
    const { sut, ctx, synology } = setup();
    const { user, newPhoto } = await newAccount(ctx);
    await newPhoto('2023/Trip/a.jpg');
    synology.albums = [
      {
        id: 7,
        name: 'Trip',
        items: [
          { id: 10, filename: 'a.jpg', folder: 1 },
          { id: 11, filename: 'gone.jpg', folder: 1 },
        ],
      },
    ];
    await sut.handleAlbumSync({ id: user.id });
    await expect(getUnmatched(ctx, user.id)).resolves.toHaveLength(1);

    await ctx.get(UserRepository).delete({ id: user.id }, true);

    await expect(
      ctx.database.selectFrom('synology_album').selectAll().where('userId', '=', user.id).execute(),
    ).resolves.toEqual([]);
    await expect(getUnmatched(ctx, user.id)).resolves.toEqual([]);
  });
});
