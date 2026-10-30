#!/bin/bash
# M2: the videos the VideoToolbox check transcodes. Real iPhone and drone footage from the library given, plus clips
# derived from it in the formats a library also meets: HDR10, 4K60 rotated, H.264 10-bit, VP9, AV1, ProRes, HEVC SDR,
# old cameras' MPEG-4 and MJPEG, odd dimensions.
#
# Usage: m2-samples.sh LIBRARY_DIR [OUT_DIR]
set -euo pipefail
library="$1"
out="${2:-/tmp/immich-m2/samples}"
F="$HOME/Library/Application Support/Immich/current/ffmpeg/ffmpeg"
mkdir -p "$out"

# real: the longest iPhone HDR video, another, an iPhone Live Photo's motion part (all HLG HEVC 10-bit, stored
# landscape and displayed portrait), and a 2.7K drone video (H.264 SDR)
pick() { find "$library" -iname "$1" -size "$2" -print -quit; }
hlg_long="$(find "$library" -iname 'IMG_*.mov' -size +30M -print -quit)"
hlg_short="$(find "$library" -iname 'IMG_*.mov' -size +3M -size -12M -print -quit)"
live="$(find "$library" -iname 'IMG_*.mov' -size -3M -print -quit)"
drone="$(pick 'DJI_*.mp4' +1k)"
for f in "$hlg_long" "$hlg_short" "$live" "$drone"; do
  [ -n "$f" ] || { echo "missing a real sample in $library" >&2; exit 1; }
done
cp "$hlg_long" "$out/real-iphone-hlg-long.mov"
cp "$hlg_short" "$out/real-iphone-hlg.mov"
cp "$live" "$out/real-iphone-live.mov"
cp "$drone" "$out/real-drone-2.7k.mp4"

enc() { # name, source, then output options
  local name="$1" src="$2"
  shift 2
  [ -f "$out/$name" ] || "$F" -v error -y -t 6 -i "$src" "$@" "$out/$name"
}
x265=(-c:v libx265 -crf 22 -preset fast)
# HDR10 (PQ) 4K, as Android phones and cameras make: the drone's picture tagged and encoded as PQ
enc derived-hdr10-4k.mp4 "$drone" -an -vf "scale=3840:2160,format=yuv420p10le" "${x265[@]}" \
  -x265-params "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400:log-level=error"
# 4K 60 fps H.264 shot holding the phone upright: stored landscape, rotated for display
enc derived-h264-4k60.mp4 "$drone" -an -vf "scale=3840:2160,fps=60" -c:v libx264 -crf 20 -preset fast
[ -f "$out/derived-h264-4k60-rotated.mp4" ] \
  || "$F" -v error -y -display_rotation 90 -i "$out/derived-h264-4k60.mp4" -c copy "$out/derived-h264-4k60-rotated.mp4"
rm -f "$out/derived-h264-4k60.mp4"
# what VideoToolbox does not decode, so the server falls back: H.264 High 10, MPEG-4 Part 2, MJPEG
enc derived-h264-10bit.mp4 "$drone" -an -vf "scale=1920:1080,format=yuv420p10le" -c:v libx264 -crf 20 -preset fast
enc derived-mpeg4.avi "$drone" -vf scale=640:480 -c:v mpeg4 -q:v 4 -c:a mp3
enc derived-mjpeg.avi "$drone" -vf "scale=640:480,format=yuvj422p" -c:v mjpeg -q:v 4 -an
# what it does decode on Apple silicon: VP9, AV1 (M3 and later), ProRes, HEVC 8-bit
enc derived-vp9.webm "$drone" -vf scale=1920:1080 -c:v libvpx-vp9 -crf 32 -b:v 0 -deadline realtime -cpu-used 8 -c:a libopus
enc derived-av1.mp4 "$drone" -an -vf scale=1920:1080 -c:v libsvtav1 -crf 35 -preset 10
enc derived-prores.mov "$drone" -an -vf scale=1920:1080 -c:v prores_ks -profile:v 3
enc derived-hevc-sdr.mp4 "$drone" -an -vf scale=1920:1080 "${x265[@]}" -tag:v hvc1 -x265-params log-level=error
# odd dimensions, which 4:2:0 cannot have: 4:4:4, as from a screen recorder, which VideoToolbox does not decode either
enc derived-odd-444.mp4 "$drone" -an -vf "scale=1279:719,format=yuv444p" -c:v libx264 -crf 20 -preset fast
ls -la "$out"
