import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final personApiRepositoryProvider = Provider(
  (ref) => PersonApiRepository(ref.watch(apiServiceProvider).peopleApi, ref.watch(apiServiceProvider).facesApi),
);

class PersonApiRepository extends ApiRepository {
  final PeopleApi _api;
  final FacesApi _facesApi;

  const PersonApiRepository(this._api, this._facesApi);

  Future<Person> update(
    String id, {
    String? name,
    DateTime? birthday,
    bool? isHidden,
    String? featureFaceAssetId,
  }) async {
    final birthdayUtc = birthday == null ? null : DateTime.utc(birthday.year, birthday.month, birthday.day);
    final dto = PersonUpdateDto(
      name: name == null ? const Optional.absent() : Optional.present(name),
      birthDate: birthdayUtc == null ? const Optional.absent() : Optional.present(birthdayUtc),
      isHidden: isHidden == null ? const Optional.absent() : Optional.present(isHidden),
      featureFaceAssetId: featureFaceAssetId == null ? const Optional.absent() : Optional.present(featureFaceAssetId),
    );
    final response = await checkNull(_api.updatePerson(id, dto));
    return _toPerson(response);
  }

  /// A new person, with no faces yet
  Future<Person> create({String? name}) async {
    final dto = PersonCreateDto(name: name == null ? const Optional.absent() : Optional.present(name));
    return _toPerson(await checkNull(_api.createPerson(dto)));
  }

  /// [sourceIds]' faces go to [targetId], whose name and birthday stay (if set); the ids of those merged. Servers
  /// before 3.2.1 only have the older endpoint.
  Future<List<String>> merge(String targetId, List<String> sourceIds) async {
    List<BulkIdResponseDto>? results;
    try {
      results = await _api.mergePeople(MergePersonDto(ids: [targetId, ...sourceIds]));
    } on ApiException catch (error) {
      if (error.code != 404) {
        rethrow;
      }
      results = await _api.mergePersonLegacy(targetId, MergePersonDto(ids: sourceIds));
    }
    final merged = {
      for (final result in results ?? const <BulkIdResponseDto>[])
        if (result.success) result.id,
    };
    return sourceIds.where(merged.contains).toList();
  }

  /// The face [faceId] is [personId]'s
  Future<void> reassignFace(String faceId, String personId) =>
      checkNull(_facesApi.reassignFacesById(personId, FaceDto(id: faceId)));

  /// Not a face, or nobody to recognize: kept by the server (and its trash) unless [force]
  Future<void> deleteFace(String faceId, {bool force = false}) =>
      _facesApi.deleteFace(faceId, AssetFaceDeleteDto(force: force));

  static Person _toPerson(PersonResponseDto dto) => .new(
    birthDate: dto.birthDate,
    id: dto.id,
    name: dto.name,
    updatedAt: dto.updatedAt.orElse(null),
    isHidden: dto.isHidden,
    isFavorite: dto.isFavorite.orElse(null) ?? false,
  );
}
