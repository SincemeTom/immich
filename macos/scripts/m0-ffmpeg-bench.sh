#!/usr/bin/env bash
# M0: checks jellyfin-ffmpeg on Apple Silicon. Generates synthetic clips like a phone records (4K HEVC 10-bit HDR in HLG
# and PQ, 1080p H.264 SDR), then transcodes each one three ways and compares speed, CPU cost and output:
#   sw       what Immich runs today with acceleration disabled (libx264 + CPU scale + tonemapx)
#   vt_enc   the same CPU decode and filters, encoded by VideoToolbox
#   vt_full  VideoToolbox decode, scale_vt / tonemap_videotoolbox on the GPU, VideoToolbox encode
# Usage: macos/scripts/m0-ffmpeg-bench.sh [path to jellyfin-ffmpeg dir] [seconds]
set -uo pipefail

bin="${1:-$HOME/Library/Caches/immich-m0/ffmpeg}"
seconds="${2:-15}"
ffmpeg="$bin/ffmpeg"
ffprobe="$bin/ffprobe"
work="${M0_FFMPEG_WORK:-/tmp/immich-m0/ffmpeg}"
mkdir -p "$work/samples" "$work/out"
rm -f "$work/out"/*

# Immich defaults (server/src/dtos/config.dto.ts): h264, crf 23, preset ultrafast, 720p, tonemap hable, aac
tonemap_cpu="tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p"
tonemap_gpu="tonemap_videotoolbox=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=nv12"
# VideoToolbox has no CRF; -q:v is its constant-quality scale (1-100) on Apple Silicon
vt_quality=60

generate() {
  local name="$1" size="$2" codec_args="$3" pixfmt="$4"
  local out="$work/samples/$name"
  [ -s "$out" ] && return
  echo "generating $name"
  # moving test pattern with temporal noise, so the encoders see detail that changes every frame
  "$ffmpeg" -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=$size:rate=30,noise=alls=12:allf=t,format=$pixfmt" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" -ac 2 \
    -t "$seconds" $codec_args -c:a aac -b:a 128k "$out"
}

# libx265 writes colour into the bitstream only from its own params; the container flags alone leave it unknown
x265_hdr="-c:v libx265 -preset ultrafast -tag:v hvc1 -color_primaries bt2020 -colorspace bt2020nc -x265-params"
generate hdr_hlg_4k.mov 3840x2160 \
  "$x265_hdr log-level=error:colorprim=bt2020:colormatrix=bt2020nc:transfer=arib-std-b67 -color_trc arib-std-b67" \
  yuv420p10le
generate hdr_pq_4k.mp4 3840x2160 \
  "$x265_hdr log-level=error:colorprim=bt2020:colormatrix=bt2020nc:transfer=smpte2084:hdr10=1:max-cll=1000,400 -color_trc smpte2084" \
  yuv420p10le
generate sdr_1080p.mp4 1920x1080 "-c:v libx264 -preset veryfast" yuv420p

for sample in hdr_hlg_4k.mov hdr_pq_4k.mp4; do
  trc=$("$ffprobe" -v error -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 "$work/samples/$sample")
  case "$trc" in
    arib-std-b67 | smpte2084) ;;
    *) echo "$sample has transfer '$trc', not HDR: delete $work/samples and rerun" >&2; exit 1 ;;
  esac
done

common_out=(-c:a aac -map 0:0 -map 0:1 -map_metadata -1 -ac 2 -movflags faststart -fps_mode passthrough)

# runs one transcode, prints: wall seconds, cpu seconds (user+sys of ffmpeg); fails with the command
timed() {
  local log="$1"
  shift
  /usr/bin/time -p "$@" 2>"$log" || return 1
  awk '/^real/ {r=$2} /^user/ {u=$2} /^sys/ {s=$2} END {printf "%s %s\n", r, u+s}' "$log"
}

printf '%-16s %-8s %8s %8s %9s %8s %7s  %s\n' sample pipeline wall_s fps cpu_s size_MB ssim output
for sample in hdr_hlg_4k.mov hdr_pq_4k.mp4 sdr_1080p.mp4; do
  in="$work/samples/$sample"
  frames=$("$ffprobe" -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$in")
  IFS=, read -r width height < <("$ffprobe" -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$in")
  # scale_vt takes no -2, so the width is worked out here the way scale=-2:720 would
  scaled_width=$(((width * 720 / height + 1) / 2 * 2))
  hdr=0
  case "$sample" in hdr_*) hdr=1 ;; esac

  for pipeline in sw vt_enc vt_full; do
    out="$work/out/${sample%.*}.$pipeline.mp4"
    case "$pipeline" in
      sw)
        filters="scale=-2:720"
        [ $hdr = 1 ] && filters="$filters,$tonemap_cpu" || filters="$filters,format=yuv420p"
        cmd=("$ffmpeg" -hide_banner -nostdin -y -i "$in" -c:v h264 "${common_out[@]}" -preset ultrafast -crf 23 -vf "$filters" "$out")
        ;;
      vt_enc)
        filters="scale=-2:720"
        [ $hdr = 1 ] && filters="$filters,$tonemap_cpu" || filters="$filters,format=yuv420p"
        cmd=("$ffmpeg" -hide_banner -nostdin -y -i "$in" -c:v h264_videotoolbox "${common_out[@]}" -q:v $vt_quality -vf "$filters" "$out")
        ;;
      vt_full)
        if [ $hdr = 1 ]; then
          filters="scale_vt=w=$scaled_width:h=720:format=p010,$tonemap_gpu"
        else
          filters="scale_vt=w=$scaled_width:h=720"
        fi
        cmd=("$ffmpeg" -hide_banner -nostdin -y -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i "$in"
          -c:v h264_videotoolbox "${common_out[@]}" -q:v $vt_quality -vf "$filters" "$out")
        ;;
    esac

    if ! read -r wall cpu < <(timed "$work/out/${sample%.*}.$pipeline.log" "${cmd[@]}"); then
      printf '%-16s %-8s FAILED, see %s\n' "$sample" "$pipeline" "$work/out/${sample%.*}.$pipeline.log"
      continue
    fi
    [ -s "$out" ] || { printf '%-16s %-8s FAILED (no output)\n' "$sample" "$pipeline"; continue; }
    fps=$(awk -v f="$frames" -v w="$wall" 'BEGIN {printf "%.0f", f / w}')
    size=$(awk -v b="$(stat -f %z "$out")" 'BEGIN {printf "%.1f", b / 1048576}')
    info=$("$ffprobe" -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt,color_transfer -of csv=p=0 "$out")
    ssim="-"
    if [ "$pipeline" != sw ]; then
      # similarity to what Immich produces today, 1.0 being identical
      ssim=$("$ffmpeg" -hide_banner -nostdin -i "$out" -i "$work/out/${sample%.*}.sw.mp4" -lavfi "[0:v][1:v]ssim" -f null - 2>&1 |
        sed -n 's/.*All:\([0-9.]*\).*/\1/p' | tail -1)
      ssim="${ssim:0:6}"
    fi
    printf '%-16s %-8s %8s %8s %9.1f %8s %7s  %s\n' "$sample" "$pipeline" "$wall" "$fps" "$cpu" "$size" "$ssim" "$info"
  done
done
