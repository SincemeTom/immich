/// How the server stacks the user's photos by itself (the fork's server only)
class AutoStackSettings {
  final bool enabled;

  /// The photos of a burst
  final bool burst;

  /// A RAW file with the JPEG or HEIC saved with it
  final bool rawJpeg;

  /// An edited copy with its original
  final bool edited;

  /// Photos that look alike, taken within [maxSeconds]
  final bool similar;

  /// The largest CLIP distance of similar photos
  final double maxDistance;
  final int maxSeconds;

  /// Photos that look all but the same, whenever taken
  final bool anytime;
  final double anytimeDistance;

  static const minSeconds = 1;
  static const maxSecondsLimit = 3600;

  /// The server's
  static const defaults = AutoStackSettings(
    enabled: true,
    burst: true,
    rawJpeg: true,
    edited: true,
    similar: true,
    maxDistance: 0.06,
    maxSeconds: 600,
    anytime: true,
    anytimeDistance: 0.03,
  );

  const AutoStackSettings({
    required this.enabled,
    required this.burst,
    required this.rawJpeg,
    required this.edited,
    required this.similar,
    required this.maxDistance,
    required this.maxSeconds,
    required this.anytime,
    required this.anytimeDistance,
  });

  AutoStackSettings copyWith({
    bool? enabled,
    bool? burst,
    bool? rawJpeg,
    bool? edited,
    bool? similar,
    double? maxDistance,
    int? maxSeconds,
    bool? anytime,
    double? anytimeDistance,
  }) => AutoStackSettings(
    enabled: enabled ?? this.enabled,
    burst: burst ?? this.burst,
    rawJpeg: rawJpeg ?? this.rawJpeg,
    edited: edited ?? this.edited,
    similar: similar ?? this.similar,
    maxDistance: maxDistance ?? this.maxDistance,
    maxSeconds: (maxSeconds ?? this.maxSeconds).clamp(minSeconds, maxSecondsLimit),
    anytime: anytime ?? this.anytime,
    anytimeDistance: anytimeDistance ?? this.anytimeDistance,
  );

  @override
  bool operator ==(Object other) =>
      other is AutoStackSettings &&
      other.enabled == enabled &&
      other.burst == burst &&
      other.rawJpeg == rawJpeg &&
      other.edited == edited &&
      other.similar == similar &&
      other.maxDistance == maxDistance &&
      other.maxSeconds == maxSeconds &&
      other.anytime == anytime &&
      other.anytimeDistance == anytimeDistance;

  @override
  int get hashCode =>
      Object.hash(enabled, burst, rawJpeg, edited, similar, maxDistance, maxSeconds, anytime, anytimeDistance);
}
