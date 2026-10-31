#!/usr/bin/env python3
"""Makes a release folder self-contained: every library a Mach-O file in it loads from outside macOS (Homebrew's, say)
is copied into <release>/lib, named by its install name, and every file that loads one is pointed at the copy through
@rpath, with an rpath relative to itself. A library in the release named by its absolute path (one built with a prefix,
like PostgreSQL's libpq) is named relative to the file instead. Then nothing names a path outside the release but
macOS's own, and the release runs wherever it is moved.

Files changed are signed ad hoc, as arm64 runs nothing unsigned; the package signs them for real afterwards.

Usage: bundle_dylibs.py RELEASE          bundles, then checks
       bundle_dylibs.py --check RELEASE  only checks: every library each file loads is in the release, or macOS's
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

SYSTEM = ("/usr/lib/", "/System/")
MACHO_MAGIC = {b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
DEP_COMMANDS = ("LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB")


def is_macho(path: Path) -> bool:
    if path.is_symlink() or not path.is_file():
        return False
    with path.open("rb") as handle:
        return handle.read(4) in MACHO_MAGIC


def load_commands(path: Path) -> dict[str, list[str]]:
    """The file's install name, the libraries it loads, and its rpaths, as its load commands give them"""
    out = subprocess.run(["otool", "-l", str(path)], capture_output=True, text=True, check=True).stdout
    found: dict[str, list[str]] = {"id": [], "deps": [], "rpaths": []}
    command = None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("cmd "):
            command = line.split()[1]
        elif line.startswith("name ") and command in (*DEP_COMMANDS, "LC_ID_DYLIB"):
            name = line[len("name "):].rsplit(" (offset", 1)[0]
            found["id" if command == "LC_ID_DYLIB" else "deps"].append(name)
        elif line.startswith("path ") and command == "LC_RPATH":
            found["rpaths"].append(line[len("path "):].rsplit(" (offset", 1)[0])
    return found


def expand(name: str, owner: Path, rpaths: list[str]) -> list[Path]:
    """Where a load command's name may point, for a file at owner (an executable's own folder for @executable_path)"""
    here = str(owner.parent)
    if name.startswith(("@loader_path/", "@executable_path/")):
        return [Path(here) / name.split("/", 1)[1]]
    if name.startswith("@rpath/"):
        rest = name[len("@rpath/"):]
        return [Path(r.replace("@loader_path", here).replace("@executable_path", here)) / rest for r in rpaths]
    return [Path(name)]


def macho_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if is_macho(p))


def run(*args: str) -> None:
    subprocess.run(args, check=True, capture_output=True)


def bundle(release: Path) -> None:
    lib = release / "lib"
    lib.mkdir(exist_ok=True)
    # a copy in lib, by the real file it copies; and the original of each copy, whose relative names point beside it
    copies: dict[Path, Path] = {}
    originals: dict[Path, Path] = {}
    # each file's load commands to change: old name -> new name
    changes: dict[Path, dict[str, str]] = {}
    pending = macho_files(release)

    while pending:
        path = pending.pop()
        commands = load_commands(path)
        source = originals.get(path, path)
        for dep in commands["deps"]:
            if dep.startswith(SYSTEM):
                continue
            if dep.startswith("/"):
                target = Path(dep)
            elif path in originals:
                # a copied library loading a sibling relatively: beside its original
                target = next((c for c in expand(dep, source, commands["rpaths"]) if c.exists()), None)
                if target is None:
                    raise SystemExit(f"{source}: cannot find {dep} through {commands['rpaths']}")
            else:
                # the release's own relative names (a wheel's .dylibs), checked afterwards
                continue
            if not target.exists():
                raise SystemExit(f"{path} loads {dep}, which is not there")
            real = target.resolve()

            if real.is_relative_to(release):
                # in the release already, by an absolute path: relative to the file instead
                new = f"@loader_path/{os.path.relpath(real, path.parent)}"
            else:
                if real not in copies:
                    ids = load_commands(real)["id"]
                    copy = lib / Path(ids[0] if ids else dep).name
                    if copy.exists():
                        raise SystemExit(f"{copy} is there already, for another library than {real}")
                    shutil.copy2(real, copy)
                    copy.chmod(0o755)
                    copies[real] = copy
                    originals[copy] = real
                    pending.append(copy)
                new = f"@rpath/{copies[real].name}"
            if new != dep:
                changes.setdefault(path, {})[dep] = new

    to_fix = set(changes) | set(originals)
    # the release's own libraries named by an absolute path, as a prefix build names them
    for path in macho_files(release):
        ids = load_commands(path)["id"]
        if ids and ids[0].startswith("/") and not ids[0].startswith(SYSTEM):
            to_fix.add(path)

    for path in sorted(to_fix):
        commands = load_commands(path)
        args: list[str] = []
        if commands["id"] and (path in originals or commands["id"][0].startswith("/")):
            args += ["-id", f"@rpath/{path.name}"]
        uses_lib = any(new.startswith("@rpath/") for new in changes.get(path, {}).values())
        for old, new in changes.get(path, {}).items():
            args += ["-change", old, new]
        for rpath in commands["rpaths"]:
            if rpath.startswith("/"):
                args += ["-delete_rpath", rpath]
        to_lib = os.path.relpath(lib, path.parent)
        wanted = "@loader_path" if to_lib == "." else f"@loader_path/{to_lib}"
        if (uses_lib or path in originals) and wanted not in commands["rpaths"]:
            args += ["-add_rpath", wanted]
        if args:
            run("install_name_tool", *args, str(path))
            run("codesign", "--force", "--sign", "-", str(path))
    print(f"bundled {len(copies)} libraries into {lib.relative_to(release.parent)}, changed {len(to_fix)} files")


def check(release: Path) -> int:
    problems = []
    files = macho_files(release)
    for path in files:
        commands = load_commands(path)
        name = path.relative_to(release)
        problems += [f"{name}: rpath {r}" for r in commands["rpaths"] if r.startswith("/")]
        for dep in commands["deps"]:
            if dep.startswith(SYSTEM):
                continue
            if dep.startswith("/"):
                problems.append(f"{name}: loads {dep}")
                continue
            hit = next((c for c in expand(dep, path, commands["rpaths"]) if c.exists()), None)
            if hit is None:
                problems.append(f"{name}: {dep} not found")
            elif not hit.resolve().is_relative_to(release):
                problems.append(f"{name}: {dep} resolves outside, to {hit.resolve()}")
    for problem in problems:
        print(f"  {problem}")
    print(f"checked {len(files)} Mach-O files: {len(problems)} problems")
    return 1 if problems else 0


def main() -> None:
    args = sys.argv[1:]
    only_check = args[:1] == ["--check"]
    if only_check:
        args = args[1:]
    if len(args) != 1:
        raise SystemExit(__doc__)
    release = Path(args[0]).resolve()
    if not only_check:
        bundle(release)
    sys.exit(check(release))


if __name__ == "__main__":
    main()
