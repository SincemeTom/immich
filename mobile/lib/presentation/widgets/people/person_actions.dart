import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/people/person_picker.widget.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';

/// What can be done to people (as on the web): hide, merge, set the feature photo, correct or remove a face
final _log = Logger('PersonActions');

/// At most this many people go into another at once, as on the web
const int kMaxPeopleToMerge = 5;

void _toast(BuildContext context, String message, {ToastType type = ToastType.success}) {
  if (context.mounted) {
    ImmichToast.show(context: context, msg: message, toastType: type);
  }
}

/// Hide [person] from the people lists, or show them again; whether it was done
Future<bool> togglePersonHidden(BuildContext context, WidgetRef ref, Person person) async {
  try {
    await ref.read(Store.people).setHidden(person.id, !person.isHidden);
    if (context.mounted) {
      _toast(context, context.t.changed_visibility_successfully);
    }
    return true;
  } catch (error, stack) {
    _log.severe('Cannot change the visibility of ${person.id}', error, stack);
    if (context.mounted) {
      _toast(context, context.t.errors.unable_to_hide_person, type: ToastType.error);
    }
    return false;
  }
}

/// Pick the people who are [target] too, and merge them into it; how many were merged
Future<int> mergeIntoPerson(BuildContext context, WidgetRef ref, Person target) async {
  final picked = await showPersonPicker(
    context,
    title: context.t.choose_matching_people_to_merge,
    exclude: {target.id},
    maxCount: kMaxPeopleToMerge,
  );
  if (picked == null || picked.people.isEmpty || !context.mounted) {
    return 0;
  }

  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => ConfirmDialog(
      title: context.t.are_these_the_same_person,
      content: context.t.merge_people_prompt,
      ok: context.t.merge,
    ),
  );
  if (confirmed != true || !context.mounted) {
    return 0;
  }

  try {
    final merged = await ref.read(Store.people).merge(target.id, [for (final person in picked.people) person.id]);
    if (context.mounted) {
      _toast(
        context,
        context.t.merged_people_count(count: merged.length),
        type: merged.length == picked.people.length ? ToastType.success : ToastType.info,
      );
    }
    return merged.length;
  } catch (error, stack) {
    _log.severe('Cannot merge into ${target.id}', error, stack);
    if (context.mounted) {
      _toast(context, context.t.errors.unable_to_merge_people, type: ToastType.error);
    }
    return 0;
  }
}

/// [person]'s thumbnail is their face on [assetId]
Future<void> setPersonFeaturePhoto(BuildContext context, WidgetRef ref, Person person, String assetId) async {
  try {
    await ref.read(Store.people).setFeaturePhoto(person.id, assetId);
    if (context.mounted) {
      _toast(context, context.t.feature_photo_updated);
    }
  } catch (error, stack) {
    _log.severe('Cannot set the feature photo of ${person.id}', error, stack);
    if (context.mounted) {
      _toast(context, context.t.errors.unable_to_set_feature_photo, type: ToastType.error);
    }
  }
}

/// [person]'s face on [assetId] is someone else's: pick them, or a new person
Future<void> reassignPersonFace(BuildContext context, WidgetRef ref, Person person, String assetId) async {
  final picked = await showPersonPicker(
    context,
    title: context.t.reassign_face_title,
    exclude: {person.id},
    allowNew: true,
  );
  if (picked == null || !context.mounted) {
    return;
  }

  final newPerson = picked.createNew ? null : picked.people.first;
  try {
    await ref.read(Store.people).reassignFaces(assetId, person.id, newPersonId: newPerson?.id);
    if (context.mounted) {
      _toast(
        context,
        newPerson == null
            ? context.t.reassigned_assets_to_new_person(count: 1)
            : context.t.reassigned_assets_to_existing_person(count: 1, name: newPerson.name),
      );
    }
  } catch (error, stack) {
    _log.severe('Cannot reassign the face of ${person.id} on $assetId', error, stack);
    if (context.mounted) {
      _toast(
        context,
        newPerson == null
            ? context.t.errors.unable_to_reassign_assets_new_person
            : context.t.errors.unable_to_reassign_assets_existing_person(name: newPerson.name),
        type: ToastType.error,
      );
    }
  }
}

/// [person]'s face on [assetId] is no face, or nobody to recognize
Future<void> deletePersonFace(BuildContext context, WidgetRef ref, Person person, String assetId) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => ConfirmDialog(
      title: context.t.delete_face,
      content: context.t.confirm_delete_face(name: person.name.isEmpty ? context.t.unknown : person.name),
      ok: context.t.delete,
    ),
  );
  if (confirmed != true || !context.mounted) {
    return;
  }

  try {
    await ref.read(Store.people).removeFaces(assetId, person.id);
    if (context.mounted) {
      _toast(context, context.t.face_deleted);
    }
  } catch (error, stack) {
    _log.severe('Cannot delete the face of ${person.id} on $assetId', error, stack);
    if (context.mounted) {
      _toast(context, context.t.errors.unable_to_delete_face, type: ToastType.error);
    }
  }
}
