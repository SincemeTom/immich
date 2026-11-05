import { ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { SynologyAlbumTable } from 'src/schema/tables/synology-album.table.js';

/** The photos the Synology album sync added to its albums: those it removes again when Synology's album drops them */
@Table('synology_album_asset')
export class SynologyAlbumAssetTable {
  @ForeignKeyColumn(() => SynologyAlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;
}
