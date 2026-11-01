import { Column, CreateDateColumn, ForeignKeyColumn, type Generated, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/** what Apple's Vision framework found in an asset's preview (content analysis, server/src/utils/content-analysis.ts) */
@Table('asset_vision')
export class AssetVisionTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  /** CONTENT_ANALYSIS_VERSION when it was analyzed: an asset of an earlier one is analyzed again */
  @Column({ type: 'smallint' })
  version!: number;

  /** Vision's aesthetics score, -1 to 1: how well taken it is, to compare photos of the same thing */
  @Column({ type: 'real', nullable: true })
  aestheticScore!: number | null;

  /** whether Vision takes it for a picture of a thing to note rather than a moment (a receipt, a document) */
  @Column({ type: 'boolean', nullable: true })
  isUtility!: boolean | null;

  @Column({ type: 'boolean', default: false })
  isScreenshot!: Generated<boolean>;

  /** the classifier's labels, the most confident first: [{ label, confidence }] */
  @Column({ type: 'jsonb' })
  labels!: { label: string; confidence: number }[];

  /** what the barcodes and QR codes in it say */
  @Column({ type: 'text', array: true })
  barcodes!: string[];

  @CreateDateColumn()
  analyzedAt!: Generated<Timestamp>;
}
