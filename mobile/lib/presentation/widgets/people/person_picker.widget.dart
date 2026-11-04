import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/string_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:immich_mobile/widgets/common/search_field.dart';

/// What was picked: some people, or (with `allowNew`) a person to create
class PersonPickerResult {
  final List<Person> people;
  final bool createNew;

  const PersonPickerResult.people(this.people) : createNew = false;
  const PersonPickerResult.createNew() : people = const [], createNew = true;
}

/// Pick one person ([maxCount] 1, picked on tap), or up to [maxCount] (confirmed by a button); not those in [exclude]
Future<PersonPickerResult?> showPersonPicker(
  BuildContext context, {
  required String title,
  Set<String> exclude = const {},
  int maxCount = 1,
  bool allowNew = false,
}) {
  return showModalBottomSheet<PersonPickerResult>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: context.colorScheme.surface,
    builder: (_) => FractionallySizedBox(
      heightFactor: 0.85,
      child: _PersonPicker(title: title, exclude: exclude, maxCount: maxCount, allowNew: allowNew),
    ),
  );
}

class _PersonPicker extends ConsumerStatefulWidget {
  final String title;
  final Set<String> exclude;
  final int maxCount;
  final bool allowNew;

  const _PersonPicker({required this.title, required this.exclude, required this.maxCount, required this.allowNew});

  @override
  ConsumerState<_PersonPicker> createState() => _PersonPickerState();
}

class _PersonPickerState extends ConsumerState<_PersonPicker> {
  String _search = '';
  final List<Person> _selected = [];

  bool get _single => widget.maxCount == 1;

  void _onTap(Person person) {
    if (_single) {
      Navigator.of(context).pop(PersonPickerResult.people([person]));
      return;
    }
    setState(() {
      if (_selected.any((p) => p.id == person.id)) {
        _selected.removeWhere((p) => p.id == person.id);
      } else if (_selected.length < widget.maxCount) {
        _selected.add(person);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final people = ref.watch(Store.people.all());
    final query = _search.toLowerCase().removeDiacritics();

    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(child: Text(widget.title, style: context.textTheme.titleMedium)),
                if (!_single)
                  FilledButton(
                    onPressed: _selected.isEmpty
                        ? null
                        : () => Navigator.of(context).pop(PersonPickerResult.people(List.of(_selected))),
                    child: Text(_selected.isEmpty ? context.t.merge : '${context.t.merge} (${_selected.length})'),
                  ),
              ],
            ),
          ),
          if (!_single && _selected.length >= widget.maxCount)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
              child: Text(
                context.t.merge_people_limit,
                style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.error),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: SearchField(
              filled: true,
              hintText: context.t.search_people,
              onChanged: (value) => setState(() => _search = value),
            ),
          ),
          if (widget.allowNew)
            ListTile(
              leading: const CircleAvatar(child: Icon(Icons.person_add_alt_1)),
              title: Text(context.t.create_new_person),
              subtitle: Text(context.t.create_new_person_hint),
              onTap: () => Navigator.of(context).pop(const PersonPickerResult.createNew()),
            ),
          Expanded(
            child: people.when(
              data: (people) {
                final shown = people
                    .where((p) => !widget.exclude.contains(p.id))
                    .where((p) => query.isEmpty || p.name.toLowerCase().removeDiacritics().contains(query))
                    .toList();
                if (shown.isEmpty) {
                  return Center(child: Text(context.t.no_results));
                }
                return GridView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 110,
                    childAspectRatio: 0.8,
                  ),
                  itemCount: shown.length,
                  itemBuilder: (context, index) {
                    final person = shown[index];
                    final selected = _selected.any((p) => p.id == person.id);
                    return _PersonTile(person: person, selected: selected, onTap: () => _onTap(person));
                  },
                );
              },
              error: (_, _) => Center(child: Text(context.t.errors.failed_to_load_people)),
              loading: () => const Center(child: CircularProgressIndicator()),
            ),
          ),
        ],
      ),
    );
  }
}

class _PersonTile extends StatelessWidget {
  final Person person;
  final bool selected;
  final VoidCallback onTap;

  const _PersonTile({required this.person, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: const BorderRadius.all(Radius.circular(12)),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(6),
        child: Column(
          children: [
            Stack(
              children: [
                Container(
                  padding: const EdgeInsets.all(3),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: selected ? context.colorScheme.primary : Colors.transparent, width: 3),
                  ),
                  child: CircleAvatar(
                    radius: 34,
                    backgroundImage: RemoteImageProvider(
                      url: getFaceThumbnailUrl(person.id, updatedAt: person.updatedAt),
                    ),
                  ),
                ),
                if (selected)
                  Positioned(
                    right: 0,
                    bottom: 0,
                    child: CircleAvatar(
                      radius: 11,
                      backgroundColor: context.colorScheme.primary,
                      child: Icon(Icons.check, size: 15, color: context.colorScheme.onPrimary),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              person.name.isEmpty ? context.t.unknown : person.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.labelMedium?.copyWith(
                color: person.name.isEmpty ? context.colorScheme.onSurfaceVariant : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
