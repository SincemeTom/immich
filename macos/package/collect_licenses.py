#!/usr/bin/env python3
"""Gathers into <release>/licenses the license of everything the release redistributes, and an index of it
(THIRD-PARTY-NOTICES.md): each component, its version, its license and where its source is. The binaries of a GPL,
LGPL or MIT component may be passed on only with its license; a GPL or LGPL one also with its source, which --sources
downloads (the exact version: Homebrew's source tarball of the formula, the tag of the rest) to keep with the release.

  Immich (this fork)                  AGPL-3.0, from this checkout
  libraries in lib/, vips/, imagemagick/, Valkey, gzip   each the Homebrew keg it came from: its license files
  PostgreSQL, pgvector, VectorChord   from the sources build-release.sh built them from
  node, jellyfin-ffmpeg, Python       from where build-release.sh took them
  npm packages (server, web UI), Python packages   a list; their license files ship inside them already
  geodata, machine learning models    attribution and terms (the models are in the .pkg, beside the release)

Usage: collect_licenses.py RELEASE --repo REPO --cache CACHE --ffmpeg-version V [--sources DIR]
Prints what it found and fails on a component whose license it cannot find, or a copyleft one without a source.
"""

import argparse
import email.parser
import json
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

CELLAR = Path("/opt/homebrew/Cellar")
LICENSE_FILE = re.compile(r"^(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)([._-].*)?$", re.IGNORECASE)
COPYLEFT = ("GPL", "LGPL", "AGPL", "MPL", "CDDL", "EPL")

# the default models, which the .pkg carries and the service otherwise downloads (immich-app on Hugging Face, which
# converts them from these originals)
MODELS = [
    ("Smart search: XLM-Roberta-Large-ViT-H-14 (OpenCLIP, LAION)", "MIT",
     "https://huggingface.co/laion/CLIP-ViT-H-14-frozen-xlm-roberta-large-laion5B-s13B-b90k", ""),
    ("Faces: buffalo_l (InsightFace)", "InsightFace model license: non-commercial research purposes only",
     "https://github.com/deepinsight/insightface/tree/master/python-package#license",
     "The code of InsightFace is MIT; its pretrained models are \"available for non-commercial research purposes "
     "only\". For any commercial use, a license from InsightFace is needed (recognition-oss-pack@insightface.ai)."),
    ("Text (OCR): PP-OCRv6_medium (PaddleOCR)", "Apache-2.0", "https://github.com/PaddlePaddle/PaddleOCR", ""),
]


# --- SPDX expressions: is the component copyleft whichever way it is taken? -----------------------------------------

def copyleft(expression: str) -> bool:
    tokens = re.findall(r"\(|\)|[^\s()]+", expression or "")
    position = 0

    def parse_or() -> bool:
        nonlocal position
        value = parse_and()
        while position < len(tokens) and tokens[position] == "OR":
            position += 1
            value = parse_and() and value  # a permissive alternative may be chosen
        return value

    def parse_and() -> bool:
        nonlocal position
        value = parse_atom()
        while position < len(tokens) and tokens[position] == "AND":
            position += 1
            value = parse_atom() or value
        return value

    def parse_atom() -> bool:
        nonlocal position
        token = tokens[position] if position < len(tokens) else ""
        position += 1
        if token == "(":
            value = parse_or()
            position += 1  # ")"
            return value
        while position < len(tokens) and tokens[position] == "WITH":
            position += 2
        return token.upper().startswith(COPYLEFT)

    return parse_or() if tokens else False


# --- helpers ---------------------------------------------------------------------------------------------------------

def fetch(url: str, cache: Path) -> Path:
    target = cache / re.sub(r"[^A-Za-z0-9._-]", "_", url.split("://", 1)[1])
    if not target.exists() or target.stat().st_size == 0:
        part = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=300) as response, part.open("wb") as handle:
            shutil.copyfileobj(response, handle)
        part.replace(target)
    return target


def license_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.iterdir() if p.is_file() and LICENSE_FILE.match(p.name)) if directory.is_dir() else []


def from_tarball(tarball: Path, destination: Path) -> list[str]:
    """The license files at the top of a source tarball (one folder deep), and in a LICENSES folder there"""
    names = []
    with tarfile.open(tarball) as archive:
        for member in archive.getmembers():
            parts = member.name.split("/")
            top = len(parts) == 2 and LICENSE_FILE.match(parts[1])
            folder = len(parts) == 3 and parts[1].lower() == "licenses" and parts[2]
            # a symlink too (glib's COPYING, into its LICENSES): extractfile follows it
            if (member.isfile() or member.issym()) and (top or folder):
                handle = archive.extractfile(member)
                if handle is None:
                    continue
                name = "/".join(parts[1:])
                (destination / name).parent.mkdir(parents=True, exist_ok=True)
                (destination / name).write_bytes(handle.read())
                names.append(name)
    return names


class Collector:
    def __init__(self, args: argparse.Namespace) -> None:
        self.release = Path(args.release)
        self.repo = Path(args.repo)
        self.cache = Path(args.cache) / "licenses"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.sources = Path(args.sources) if args.sources else None
        self.ffmpeg_version = args.ffmpeg_version
        self.out = self.release / "licenses"
        self.rows: list[dict[str, str]] = []
        self.problems: list[str] = []
        self.meta = dict(line.split("=", 1) for line in (self.release / "RELEASE").read_text().splitlines() if "=" in line)

    def add(self, name: str, version: str, license: str, source: str, folder: str, files: list[str],
            archive: Path | str | None = None) -> None:
        if not files:
            self.problems.append(f"{name}: no license file found")
        row = {"name": name, "version": version, "license": license, "source": source, "folder": folder,
               "files": ", ".join(files), "copyleft": "yes" if copyleft(license) else ""}
        if copyleft(license) and self.sources is not None:
            if archive is None:
                self.problems.append(f"{name}: copyleft ({license}) and no source to archive")
            else:
                row["archived"] = self.archive(name, version, archive)
        self.rows.append(row)

    def archive(self, name: str, version: str, archive: Path | str) -> str:
        """The component's source, kept with the release"""
        assert self.sources is not None
        self.sources.mkdir(parents=True, exist_ok=True)
        if isinstance(archive, str):  # a URL
            archive = fetch(archive, self.cache)
        key = re.match(r"[A-Za-z0-9.+_-]+", name).group().lower()  # the component's name, without what describes it
        target = self.sources / f"{key}-{version}{''.join(archive.suffixes[-2:]) or '.tar.gz'}"
        if not target.exists():
            shutil.copyfile(archive, target)
        return target.name

    # --- the components ------------------------------------------------------------------------------------------

    def immich(self) -> None:
        folder = self.out / "immich"
        folder.mkdir(parents=True)
        shutil.copy(self.repo / "LICENSE", folder / "LICENSE")
        commit = self.meta.get("commit", "")
        url = self.meta.get("repository", "https://github.com/SincemeTom/immich")
        archive = None
        if self.sources is not None:
            archive = self.cache / f"immich-{commit[:12]}.tar.gz"
            subprocess.run(["git", "-C", str(self.repo), "archive", "--format=tar.gz", f"--prefix=immich-{commit[:12]}/",
                            "-o", str(archive), commit], check=True)
        self.add("Immich, native macOS build (this fork of immich-app/immich)", self.meta.get("id", "?"), "AGPL-3.0-only",
                 f"{url}/tree/{commit}", "immich", ["LICENSE"], archive)

    def homebrew(self) -> None:
        by_name: dict[str, set[str]] = {}
        for library in CELLAR.glob("*/*/lib/**/*"):
            if library.suffix in (".dylib", ".so") or ".dylib" in library.name:
                by_name.setdefault(library.name, set()).add(library.parts[len(CELLAR.parts)])
        shipped = [*(self.release / "lib").iterdir(), *(self.release / "vips").rglob("*.dylib"),
                   *(self.release / "imagemagick").rglob("*.so")]
        formulae: set[str] = {"valkey", "gzip"}
        for library in shipped:
            owners = by_name.get(library.name)
            if owners:
                formulae |= owners
            elif library.is_file():
                self.problems.append(f"{library.relative_to(self.release)}: from no Homebrew keg")
        info = json.loads(subprocess.run(["brew", "info", "--json=v2", *sorted(formulae)], capture_output=True,
                                         text=True, check=True).stdout)
        for formula in info["formulae"]:
            name = formula["name"]
            installed = sorted((CELLAR / name).iterdir())[-1]
            version = installed.name
            url = formula["urls"]["stable"]["url"]
            if re.sub(r"_\d+$", "", version) != formula["versions"]["stable"]:
                self.problems.append(f"{name}: {version} installed, the formula is now {formula['versions']['stable']}: "
                                     "its source URL is not the installed one's")
            folder = self.out / "homebrew" / name
            files = []
            for path in license_files(installed):
                folder.mkdir(parents=True, exist_ok=True)
                shutil.copy(path, folder / path.name)
                files.append(path.name)
            if not files:  # Homebrew installed none: the source tarball's
                files = from_tarball(fetch(url, self.cache), folder)
            self.add(name, version, formula["license"] or "?", url, f"homebrew/{name}", files, url)

    def postgres(self) -> None:
        cache = self.cache.parent
        for name, version, license, url, directory, archive in [
            ("PostgreSQL", self.meta["postgres"], "PostgreSQL", "https://www.postgresql.org/ftp/source/",
             cache / "build" / f"postgresql-{self.meta['postgres']}", None),
            ("pgvector", self.meta["pgvector"], "PostgreSQL", f"https://github.com/pgvector/pgvector/tree/v{self.meta['pgvector']}",
             cache / "build" / f"pgvector-{self.meta['pgvector']}", None),
            ("VectorChord (used under AGPL-3.0, one of its two licenses)", self.meta["vectorchord"], "AGPL-3.0-only",
             f"https://github.com/tensorchord/VectorChord/tree/{self.meta['vectorchord']}",
             cache / "src" / f"vectorchord-{self.meta['vectorchord']}",
             f"https://github.com/tensorchord/VectorChord/archive/refs/tags/{self.meta['vectorchord']}.tar.gz"),
        ]:
            folder = self.out / name.split(" ")[0].lower()
            files = []
            for path in license_files(directory):
                folder.mkdir(parents=True, exist_ok=True)
                shutil.copy(path, folder / path.name)
                files.append(path.name)
            if (directory / "licenses").is_dir():  # VectorChord's texts of both
                shutil.copytree(directory / "licenses", folder / "licenses")
                files.append("licenses/")
            self.add(name, version, license, url, folder.name, files, archive)

    def node(self) -> None:
        version = self.meta["node"]
        node = Path(subprocess.run(["mise", "which", "node"], cwd=self.repo, capture_output=True, text=True,
                                   check=True).stdout.strip()).resolve().parent.parent
        folder = self.out / "node"
        folder.mkdir(parents=True)
        shutil.copy(node / "LICENSE", folder / "LICENSE")
        self.add("Node.js", version, "MIT AND others (see LICENSE)", f"https://github.com/nodejs/node/tree/{version}",
                 "node", ["LICENSE"])

    def ffmpeg(self) -> None:
        version = self.ffmpeg_version
        tag = f"https://raw.githubusercontent.com/jellyfin/jellyfin-ffmpeg/v{version}"
        folder = self.out / "jellyfin-ffmpeg"
        folder.mkdir(parents=True)
        files = []
        for name in ("LICENSE.md", "COPYING.GPLv3", "COPYING.GPLv2", "COPYING.LGPLv2.1", "COPYING.LGPLv3"):
            try:
                shutil.copy(fetch(f"{tag}/{name}", self.cache), folder / name)
                files.append(name)
            except OSError:
                pass
        configuration = subprocess.run([str(self.release / "ffmpeg" / "ffmpeg"), "-hide_banner", "-version"],
                                       capture_output=True, text=True).stdout
        libraries = sorted(set(re.findall(r"--enable-(lib[a-z0-9]+)", configuration)))
        (folder / "BUILD.md").write_text(
            f"# jellyfin-ffmpeg {version}\n\nThe macOS build Jellyfin publishes, statically linked. Built with "
            "`--enable-gpl --enable-version3`: as a whole it is under the GPL, version 3.\n\n"
            f"Libraries linked into it: {', '.join(libraries)}.\n\n"
            f"Source: https://github.com/jellyfin/jellyfin-ffmpeg/tree/v{version} (its `builder/` names the version "
            "of each library it builds).\n\n```\n" + configuration.strip() + "\n```\n")
        self.add(f"jellyfin-ffmpeg (ffmpeg, ffprobe; with {', '.join(libraries)})", version, "GPL-3.0-or-later",
                 f"https://github.com/jellyfin/jellyfin-ffmpeg/tree/v{version}", "jellyfin-ffmpeg", files,
                 f"https://github.com/jellyfin/jellyfin-ffmpeg/archive/refs/tags/v{version}.tar.gz")

    def python(self) -> None:
        python = self.release / "ml" / "python"
        version = subprocess.run([str(python / "bin" / "python3"), "-c", "import platform; print(platform.python_version())"],
                                 capture_output=True, text=True, check=True).stdout.strip()
        folder = self.out / "python"
        folder.mkdir(parents=True)
        shutil.copy(python / "lib" / "python3.12" / "LICENSE.txt", folder / "LICENSE.txt")
        self.add("CPython (python-build-standalone)", version, "PSF-2.0 AND others (see LICENSE.txt)",
                 "https://github.com/astral-sh/python-build-standalone", "python", ["LICENSE.txt"])
        lines = ["# Python packages of the machine learning service", "",
                 "Each package's own license files ship with it, in `ml/python/lib/python3.12/site-packages/"
                 "<package>.dist-info/`.", "", "| Package | Version | License |", "|---|---|---|"]
        for metadata in sorted((python / "lib" / "python3.12" / "site-packages").glob("*.dist-info/METADATA")):
            fields = email.parser.Parser().parsestr(metadata.read_text(errors="replace"), headersonly=True)
            license = fields.get("License-Expression") or ""
            if not license:
                classifiers = [c.split(" :: ")[-1] for c in fields.get_all("Classifier") or [] if c.startswith("License ::")]
                text = (fields.get("License") or "").strip().splitlines()
                license = "; ".join(classifiers) if classifiers else (text[0][:80] if text else "?")
            lines.append(f"| {fields['Name']} | {fields['Version']} | {license or '?'} |")
        (folder / "packages.md").write_text("\n".join(lines) + "\n")

    def npm(self) -> None:
        lines = ["# npm packages of the server and the web UI", "",
                 "The server's ship with their own license files, in `server/node_modules`; the web UI's are compiled "
                 "into `build/www`.", ""]
        for title, package in (("Server", "immich"), ("Web UI", "immich-web")):
            listing = json.loads(subprocess.run(["mise", "exec", "--", "pnpm", "--filter", package, "licenses", "list",
                                                 "--prod", "--json"], cwd=self.repo, capture_output=True, text=True,
                                                check=True).stdout)
            entries = sorted((p["name"], ", ".join(p["versions"]), license) for license, packages in listing.items()
                             for p in packages)
            lines += [f"## {title} ({len(entries)})", "", "| Package | Version | License |", "|---|---|---|"]
            lines += [f"| {name} | {versions} | {license} |" for name, versions, license in entries]
            lines.append("")
            copyleft_ones = [f"{n} ({lic})" for n, _, lic in entries if copyleft(lic)]
            if copyleft_ones:
                lines += [f"Copyleft among them: {', '.join(copyleft_ones)}.", ""]
        (self.out / "npm-packages.md").write_text("\n".join(lines))

    def data(self) -> None:
        folder = self.out / "data"
        folder.mkdir(parents=True)
        (folder / "geodata.md").write_text(
            "# Geodata (reverse geocoding, `build/geodata`)\n\n"
            "- City, region and country names: GeoNames (https://www.geonames.org), under CC BY 4.0 "
            "(https://creativecommons.org/licenses/by/4.0/). Files used: cities500, admin1CodesASCII, admin2Codes, "
            "countryInfo, unchanged.\n"
            "- Country borders: Natural Earth (https://www.naturalearthdata.com), public domain.\n")
        lines = ["# Machine learning models", "",
                 "The .pkg carries the default models; the service downloads any other one chosen in the settings "
                 "from Hugging Face (immich-app), which converts them from the originals below. Each is under the "
                 "terms of its original.", ""]
        for name, license, url, note in MODELS:
            lines += [f"## {name}", "", f"- License: {license}", f"- Original: {url}"] + ([f"- {note}"] if note else []) + [""]
        (folder / "models.md").write_text("\n".join(lines))

    # --- the index -----------------------------------------------------------------------------------------------

    def index(self) -> None:
        repository = self.meta.get("repository", "https://github.com/SincemeTom/immich")
        lines = [
            f"# Third-party notices: Immich native macOS build {self.meta.get('id', '')}", "",
            "This build is an unofficial, community build of Immich for macOS. It is not made, endorsed or supported by "
            "the Immich team or FUTO. Immich is free software under the GNU Affero General Public License, version 3 "
            f"(`immich/LICENSE`); the source of this build is at {repository}/tree/{self.meta.get('commit', '')}.", "",
            "It is provided without any warranty, as the licenses below say.", "",
            "Everything else it carries is listed here, with its license (the texts are in the folder named) and its "
            "source. For a component under the GPL or LGPL (marked copyleft), the corresponding source of the version "
            "shipped can be had from the link, and is kept with each release; ask through the project's GitHub page.", "",
            "| Component | Version | License | Copyleft | Texts | Source |", "|---|---|---|---|---|---|"]
        for row in self.rows:
            lines.append(f"| {row['name']} | {row['version']} | {row['license']} | {row['copyleft']} | "
                         f"`{row['folder']}/` | {row['source']} |")
        lines += ["", "Also: `python/packages.md` (the machine learning service's Python packages), `npm-packages.md` "
                  "(the server's and the web UI's), `data/geodata.md`, `data/models.md` (the models, among them the "
                  "face model, whose license allows non-commercial research use only).", ""]
        (self.out / "THIRD-PARTY-NOTICES.md").write_text("\n".join(lines))

    def run(self) -> None:
        shutil.rmtree(self.out, ignore_errors=True)
        self.out.mkdir()
        for step in (self.immich, self.homebrew, self.postgres, self.node, self.ffmpeg, self.python, self.npm, self.data):
            step()
        self.index()
        copyleft_rows = [r for r in self.rows if r["copyleft"]]
        print(f"{len(self.rows)} components, {len(copyleft_rows)} copyleft: "
              + ", ".join(f"{re.match(r'[A-Za-z0-9.+_-]+', r['name']).group()} {r['version']}" for r in copyleft_rows))
        if self.sources is not None:
            size = sum(p.stat().st_size for p in self.sources.iterdir())
            print(f"their sources: {self.sources} ({size / 1e6:.0f} MB)")
        for problem in self.problems:
            print(f"  problem: {problem}")
        if self.problems:
            sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("release")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--ffmpeg-version", required=True)
    parser.add_argument("--sources")
    Collector(parser.parse_args()).run()


if __name__ == "__main__":
    main()
