/// A location the server inferred from the photos taken around the asset, not read from its file
class InferredLocation {
  /// The photo it was taken from, when the server still knows it
  final InferredLocationSource? source;

  const InferredLocation({this.source});

  @override
  bool operator ==(Object other) => other is InferredLocation && other.source == source;

  @override
  int get hashCode => source.hashCode;
}

class InferredLocationSource {
  /// The photo, null when it is not shared with the user
  final String? assetId;

  /// When it was taken, in the time where it was taken
  final DateTime takenAt;

  final String ownerId;
  final String ownerName;

  const InferredLocationSource({
    required this.assetId,
    required this.takenAt,
    required this.ownerId,
    required this.ownerName,
  });

  @override
  bool operator ==(Object other) =>
      other is InferredLocationSource &&
      other.assetId == assetId &&
      other.takenAt == takenAt &&
      other.ownerId == ownerId &&
      other.ownerName == ownerName;

  @override
  int get hashCode => Object.hash(assetId, takenAt, ownerId, ownerName);
}
