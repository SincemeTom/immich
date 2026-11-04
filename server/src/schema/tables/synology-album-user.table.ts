import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { SynologyAlbumTable } from 'src/schema/tables/synology-album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The members the Synology album sync shared its albums with, as Synology Photos shares them: those it changes or
 * removes again when Synology's sharing changes. A member the album's owner added by hand is not here.
 */
@Table('synology_album_user')
export class SynologyAlbumUserTable {
  @ForeignKeyColumn(() => SynologyAlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  userId!: string;

  /** Synology's role when last synced (view, download, upload): the member's access is set again when it changes */
  @Column()
  role!: string;
}
