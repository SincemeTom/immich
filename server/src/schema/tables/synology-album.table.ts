import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Table,
  Timestamp,
  Unique,
} from '@immich/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The albums the Synology album sync created, each from an album of the user's Synology Photos. Only these, and only
 * the photos it added to them (synology_album_asset), does the sync change or remove again.
 */
@Table('synology_album')
@Unique({ columns: ['userId', 'source', 'synologyAlbumId'] })
export class SynologyAlbumTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  userId!: string;

  /**
   * The Synology account it came from: its address and its Synology Photos user ID. Albums of an account bound before
   * are left as they are.
   */
  @Column()
  source!: string;

  @Column({ type: 'integer' })
  synologyAlbumId!: number;

  /** the Synology album's name when it was last synced: the album is renamed when Synology's changes */
  @Column()
  name!: string;

  /** the Synology item of the cover last taken over: the cover is set again when Synology's changes */
  @Column({ type: 'integer', nullable: true })
  thumbnailItemId!: number | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  syncedAt!: Generated<Timestamp>;
}
