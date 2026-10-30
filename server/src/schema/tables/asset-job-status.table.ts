import { Column, ForeignKeyColumn, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_job_status')
export class AssetJobStatusTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  facesRecognizedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  metadataExtractedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  duplicatesDetectedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  ocrAt!: Timestamp | null;

  /** when it was stacked automatically: one taken out of its stack again is then left alone */
  @Column({ type: 'timestamp with time zone', nullable: true })
  autoStackedAt!: Timestamp | null;
}
