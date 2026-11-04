import { Column, ForeignKeyColumn, type Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * What the user's last Synology album sync could not match: albums it did not create or could not read, and photos
 * not found, found more than once, or whose owners are not in Immich yet. Each sync replaces the user's list.
 */
@Table('synology_unmatched')
export class SynologyUnmatchedTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  userId!: string;

  @Column({ type: 'integer' })
  synologyAlbumId!: number;

  @Column()
  albumName!: string;

  /** SynologyUnmatchedReason */
  @Column()
  reason!: string;

  /** the photo, as its path in Synology Photos, or only its name when its folder could not be read; none for an album */
  @Column({ nullable: true })
  path!: string | null;

  /** whether the photo is the account's own, not one another user added */
  @Column({ type: 'boolean', default: true })
  mine!: Generated<boolean>;
}
