import { Column, CreateDateColumn, ForeignKeyColumn, type Generated, Index, Table, Timestamp } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * What Apple's Vision and Speech frameworks found in an asset (content analysis, server/src/utils/content-analysis.ts):
 * in its preview, and in a video, what is said in it
 */
@Table('asset_vision')
@Index({
  name: 'idx_asset_vision_transcript',
  using: 'gin',
  expression: 'f_unaccent("transcript") gin_trgm_ops',
})
export class AssetVisionTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  /** CONTENT_ANALYSIS_VERSION when it was analyzed: an asset of an earlier one is analyzed again */
  @Column({ type: 'smallint' })
  version!: number;

  /**
   * The requests that have been made of it, each succeeding: on a Mac that can do more (macOS 26), the asset is
   * analyzed again for what is missing
   */
  @Column({ type: 'text', array: true })
  features!: string[];

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

  /** whether it is a picture of a document (macOS 26) */
  @Column({ type: 'boolean', nullable: true })
  isDocument!: boolean | null;

  /** how likely the lens was smudged, 0 to 1 (macOS 26) */
  @Column({ type: 'real', nullable: true })
  smudge!: number | null;

  /**
   * What is said in a video, to search (macOS 26): its words as OCR keeps those of a photo, Chinese in pairs of
   * characters (tokenizeForSearch); empty when nothing is said, null when not listened to. The words themselves are in
   * transcriptSegments.
   */
  @Column({ type: 'text', nullable: true })
  transcript!: string | null;

  /** the same, with when: [{ start, end, text }], in seconds */
  @Column({ type: 'jsonb', nullable: true })
  transcriptSegments!: { start: number; end: number; text: string }[] | null;

  /** the language it was listened to in */
  @Column({ type: 'text', nullable: true })
  transcriptLanguage!: string | null;

  @CreateDateColumn()
  analyzedAt!: Generated<Timestamp>;
}
