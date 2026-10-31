#!/bin/bash
# Removes a Docker (docker compose) install of Immich, to make way for the .pkg: its containers, images, networks and
# local volumes (the machine learning model cache), and the thumbnails and transcoded videos it generated (thumbs/,
# encoded-video/). Originals (library/, upload/), profile pictures, database backups and external libraries are not
# touched; the database only with --purge-db.
#
# Where the files are comes from immich-server's own mounts, NAS ones included, and the cleaning is done in a container
# with those mounts: the same for a folder, a named volume or an NFS/SMB volume. A NAS that is not mounted stops it
# before anything is done.
#
# Usage: macos/scripts/remove-docker-immich.sh [options]
#   --dry-run        only show what would be done
#   --yes            do not ask before doing it
#   --project NAME   the compose project, when this Mac has more than one Immich
#   --purge-db       delete the database too
set -euo pipefail

dry_run="" yes="" project="" purge_db=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes) yes=1 ;;
    --project) project="$2"; shift ;;
    --purge-db) purge_db=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    \033[33m%s\033[0m\n' "$1" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "没有 docker 命令"
docker info >/dev/null 2>&1 || die "Docker 没有在运行：先打开 Docker Desktop（或 OrbStack）"

# --- what there is -----------------------------------------------------------------------------------------------

if [ -z "$project" ]; then
  projects="$(docker ps -a --filter label=com.docker.compose.service=immich-server \
    --format '{{.Label "com.docker.compose.project"}}' | sort -u | grep . || true)"
  [ -n "$projects" ] || die "没有找到 Docker 版 Immich（docker compose 的 immich-server 容器）"
  [ "$(printf '%s\n' "$projects" | wc -l | tr -d ' ')" -eq 1 ] \
    || die "找到多个 Immich：$(echo $projects)，用 --project 选一个"
  project="$projects"
fi

in_project() { docker ps -aq --filter "label=com.docker.compose.project=$project" "$@"; }
# type|volume name|host path|path in the container, a line per mount
mounts_of() { docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}{{println}}{{end}}' "$1"; }

server="$(in_project --filter label=com.docker.compose.service=immich-server | head -1)"
[ -n "$server" ] || die "项目 $project 里没有 immich-server 容器"
server_image="$(docker inspect -f '{{.Image}}' "$server")"
workdir="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$server")"
server_mounts="$(mounts_of "$server" | grep . || true)"

while IFS='|' read -r type _ src dest; do
  [ "$type" = bind ] || continue
  [ -e "$src" ] || die "immich-server 挂载的 ${src}（容器里的 ${dest}）不存在：NAS 没连上？在 Finder 里连接好再运行（还什么都没动）"
done <<<"$server_mounts"

# Thumbnails and transcoded videos: in the upload folder (/data since Immich 2, /usr/src/app/upload before), or each
# mounted on its own
targets=() descriptions=()
for base in /data /usr/src/app/upload; do
  for sub in thumbs encoded-video; do
    rel=""
    line="$(printf '%s\n' "$server_mounts" | awk -F'|' -v d="$base/$sub" '$4 == d' | head -1)"
    if [ -z "$line" ]; then
      line="$(printf '%s\n' "$server_mounts" | awk -F'|' -v d="$base" '$4 == d' | head -1)"
      rel="/$sub"
    fi
    [ -n "$line" ] || continue
    IFS='|' read -r type name src _ <<<"$line"
    case "$type" in
      bind) where="$src$rel" ;;
      volume) where="卷 $name${rel:+ 里的 ${rel#/}/}" ;;
      *) warn "$base/$sub 的挂载类型是 ${type}，跳过"; continue ;;
    esac
    targets+=("$base/$sub")
    descriptions+=("$where")
  done
done

# Only the official compose file's services: anything else in the same project is left alone
KNOWN=" immich-server immich-microservices immich-machine-learning redis database "
remove=() names=() kept=() images=()
for id in $(in_project); do
  service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
  name="$(docker inspect -f '{{.Name}}' "$id")"
  name="${name#/}"
  case "$KNOWN" in
    *" $service "*)
      remove+=("$id")
      names+=("$name")
      image="$(docker inspect -f '{{.Config.Image}}' "$id")"
      case " ${images[*]-} " in *" $image "*) ;; *) images+=("$image") ;; esac
      ;;
    *) kept+=("$name") ;;
  esac
done

db_type="" db_name="" db_src="" db_dir=""
db="$(in_project --filter label=com.docker.compose.service=database | head -1)"
if [ -n "$db" ]; then
  IFS='|' read -r db_type db_name db_src _ \
    <<<"$(mounts_of "$db" | awk -F'|' '$4 == "/var/lib/postgresql/data"' | head -1)"
fi
if [ -n "$purge_db" ] && [ "$db_type" = bind ] && [ -d "$db_src" ]; then
  db_dir="$(cd "$db_src" && pwd -P)"
  [ -f "$db_dir/PG_VERSION" ] || die "$db_dir 里没有 PG_VERSION，不像数据库目录，停止（还什么都没动）"
  while IFS='|' read -r type _ src dest; do
    [ "$type" = bind ] || continue
    real="$(cd "$src" 2>/dev/null && pwd -P || echo "$src")"
    case "$real/" in
      "$db_dir/"*) die "immich-server 的 ${dest}（${real}）在数据库目录里面，停止（还什么都没动）" ;;
    esac
  done <<<"$server_mounts"
fi

# The project's volumes, but not one immich-server mounts (it may hold originals), nor the database's unless asked
server_volumes="$(printf '%s\n' "$server_mounts" | awk -F'|' '$1 == "volume" { print $2 }')"
volumes=() kept_volumes=()
for v in $(docker volume ls -q --filter "label=com.docker.compose.project=$project"); do
  if printf '%s\n' "$server_volumes" | grep -qxF "$v"; then
    kept_volumes+=("${v}（immich-server 的上传目录）")
  elif [ "$v" = "$db_name" ] && [ -z "$purge_db" ]; then
    kept_volumes+=("${v}（数据库，加 --purge-db 才删）")
  else
    volumes+=("$v")
  fi
done
networks=()
for n in $(docker network ls -q --filter "label=com.docker.compose.project=$project"); do
  networks+=("$(docker network inspect -f '{{.Name}}' "$n")")
done

# --- plan --------------------------------------------------------------------------------------------------------

step "Docker 版 Immich：项目 $project${workdir:+（${workdir}）}"
info "删除容器：${names[*]}"
info "删除镜像：${images[*]}"
[ ${#volumes[@]} -gt 0 ] && info "删除卷：${volumes[*]}"
[ ${#networks[@]} -gt 0 ] && info "删除网络：${networks[*]}"
for k in ${kept[@]+"${kept[@]}"}; do info "保留容器：$k"; done
for k in ${kept_volumes[@]+"${kept_volumes[@]}"}; do info "保留卷：$k"; done

step "清理缩略图和转码视频"
if [ ${#targets[@]} -eq 0 ]; then
  warn "immich-server 没有挂载上传目录，没有要清理的"
fi
for d in ${descriptions[@]+"${descriptions[@]}"}; do info "$d"; done
info "不动：原图（library/、upload/）、头像（profile/）、数据库备份（backups/）、外部图库"

step "数据库"
if [ -z "$db_type" ]; then
  info "没有找到"
elif [ -n "$db_dir" ]; then
  info "删除 $db_dir"
elif [ "$db_type" = bind ]; then
  info "保留 $db_src${purge_db:+（不存在）}"
elif [ -n "$purge_db" ]; then
  info "删除卷 $db_name"
else
  info "保留卷 $db_name"
fi
[ -n "$purge_db" ] || info "新版用不到它，加 --purge-db 一起删"

if [ -n "$dry_run" ]; then
  echo
  echo "--dry-run：什么都没做"
  exit 0
fi
if [ -z "$yes" ]; then
  echo
  read -r -p "继续？[y/N] " answer
  case "$answer" in y | Y | yes) ;; *) echo "取消了"; exit 1 ;; esac
fi

# --- doing it ----------------------------------------------------------------------------------------------------

step "停止容器"
docker stop "${remove[@]}" >/dev/null
info "已停止"

if [ ${#targets[@]} -gt 0 ]; then
  step "清理缩略图和转码视频（文件多、在 NAS 上时要一段时间）"
  # In a container with immich-server's mounts, as root like Immich; never into another mount (--one-file-system)
  for i in "${!targets[@]}"; do
    docker run --rm --network none --volumes-from "$server" --entrypoint /bin/sh "$server_image" -c '
      [ -d "$1" ] || { echo "不存在"; exit 0; }
      find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system {} +
      rmdir "$1" 2>/dev/null || true
      echo "已清理"' sh "${targets[$i]}" | sed "s|^|    ${descriptions[$i]}：|" \
      || die "清理 ${descriptions[$i]} 失败。容器已停止但还没删，可以重新运行"
  done
fi

step "删除容器、镜像、卷和网络"
docker rm -f "${remove[@]}" >/dev/null
info "容器：已删除"
for image in "${images[@]}"; do
  if docker image rm "$image" >/dev/null 2>&1; then info "镜像 ${image}：已删除"; else warn "镜像 ${image}：没删掉，还有别的容器在用？"; fi
done
for v in ${volumes[@]+"${volumes[@]}"}; do
  if docker volume rm "$v" >/dev/null 2>&1; then info "卷 ${v}：已删除"; else warn "卷 ${v}：没删掉，还有别的容器在用？"; fi
done
for n in ${networks[@]+"${networks[@]}"}; do
  if docker network rm "$n" >/dev/null 2>&1; then info "网络 ${n}：已删除"; else warn "网络 ${n}：没删掉，还有别的容器在用？"; fi
done
if [ -n "$db_dir" ]; then
  if rm -rf "$db_dir"; then info "数据库 ${db_dir}：已删除"; else warn "数据库 ${db_dir}：没删干净，可以手动删除"; fi
fi

step "完成"
originals="$(printf '%s\n' "$server_mounts" | awk -F'|' '$4 == "/data" || $4 == "/usr/src/app/upload" {
  print ($1 == "bind" ? $3 : "卷 " $2) }' | head -1)"
[ -n "$originals" ] && info "原图都还在：$originals"
if [ -n "$workdir" ]; then
  info "docker-compose.yml 和 .env 还在 ${workdir}，不用了可以手动删除。"
  info "上传目录如果也在这个文件夹里（默认的 ./library 就是），不要整个删掉。"
fi
info "确认端口已空出来，再装 .pkg：lsof -nP -iTCP:2283 -sTCP:LISTEN"
