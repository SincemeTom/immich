import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/presentation/widgets/people/person_actions.dart';
import 'package:immich_mobile/presentation/widgets/people/person_option_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/utils/people.utils.dart';
import 'package:immich_mobile/widgets/common/person_sliver_app_bar.dart';

@RoutePage()
class PersonPage extends ConsumerStatefulWidget {
  final Person person;

  const PersonPage({super.key, required this.person});

  @override
  ConsumerState<PersonPage> createState() => _PersonPageState();
}

class _PersonPageState extends ConsumerState<PersonPage> {
  late Person _person;

  @override
  void initState() {
    super.initState();
    _person = widget.person;
  }

  Future<void> handleEditName(BuildContext context) async {
    final newName = await showNameEditModal(context, _person);

    if (newName != null && newName.isNotEmpty) {
      setState(() {
        _person = _person.copyWith(name: newName);
      });
    }
  }

  Future<void> handleEditBirthday(BuildContext context) async {
    final birthday = await showBirthdayEditModal(context, _person);

    if (birthday != null) {
      setState(() {
        _person = _person.copyWith(birthDate: birthday);
      });
    }
  }

  Future<void> showOptionSheet(BuildContext context) {
    return showModalBottomSheet(
      context: context,
      backgroundColor: context.colorScheme.surface,
      isScrollControlled: false,
      builder: (sheetContext) {
        return PersonOptionSheet(
          onEditName: () async {
            await handleEditName(sheetContext);
            ContextHelper(sheetContext).pop();
          },
          onEditBirthday: () async {
            await handleEditBirthday(sheetContext);
            ContextHelper(sheetContext).pop();
          },
          birthdayExists: _person.birthDate != null,
          onMerge: () async {
            ContextHelper(sheetContext).pop();
            await mergeIntoPerson(context, ref, _person);
          },
          isHidden: _person.isHidden,
          onToggleHidden: () async {
            ContextHelper(sheetContext).pop();
            final hiding = !_person.isHidden;
            if (await togglePersonHidden(context, ref, _person) && hiding && context.mounted) {
              await context.maybePop();
            }
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    // the name, birthday and thumbnail as they change (renamed, merged into, new feature photo)
    ref.listen(Store.people.byId(widget.person.id), (_, next) {
      final person = next.valueOrNull;
      if (person != null && person != _person) {
        setState(() => _person = person);
      }
    });

    return ProviderScope(
      overrides: [
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to view person timeline');
          }

          final users = ref.watch(timelineUsersProvider).valueOrNull ?? [user.id];
          final timelineService = ref.watch(timelineFactoryProvider).person(users, _person.id);
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: Timeline(
        appBar: PersonSliverAppBar(
          person: _person,
          onNameTap: () => handleEditName(context),
          onBirthdayTap: () => handleEditBirthday(context),
          onShowOptions: () => showOptionSheet(context),
        ),
      ),
    );
  }
}
