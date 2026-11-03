const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico', 'jxl', 'qoi', 'tga'])
const VIDEO = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv'])

export const PNG_DIRECT_PIXELS = 4096
export const PNG_DIRECT_BYTES = 8_000_000
export const CACHE_KEEP = 64
export const EXIT_MISSING = 3
export const EXIT_FAILED = 4
export const EXIT_LOCKED = 5

const CODERS: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', bmp: 'bmp', tif: 'tiff', tiff: 'tiff', avif: 'avif', heic: 'heic', heif: 'heic', ico: 'ico', jxl: 'jxl', qoi: 'qoi', tga: 'tga' }
const DOCS: Record<string, string> = { pdf: 'pdf', docx: 'office', doc: 'office', odt: 'office', rtf: 'office' }
const DEMUXERS: Record<string, string> = { mp4: 'mov', m4v: 'mov', mov: 'mov', '3gp': 'mov', mkv: 'matroska', webm: 'matroska', avi: 'avi', wmv: 'asf', flv: 'flv', mpg: 'mpeg', mpeg: 'mpeg', ogv: 'ogg' }

export const POLICY = [
  '<policymap>',
  '  <policy domain="delegate" rights="none" pattern="*"/>',
  '  <policy domain="coder" rights="none" pattern="*"/>',
  '  <policy domain="coder" rights="read" pattern="{PNG,JPEG,GIF,WEBP,BMP,TIFF,AVIF,HEIC,ICO,JXL,QOI,TGA}"/>',
  '  <policy domain="coder" rights="write" pattern="PNG"/>',
  '  <policy domain="path" rights="none" pattern="@*"/>',
  '  <policy domain="filter" rights="none" pattern="*"/>',
  '</policymap>',
].join('\n')

export const POSTER = [
  'src=$1 base=$2 session=$3 name=$4 kind=$5 coder=$6 keep=$7 policy=$8 page=${9:-1} px=${10:-1200} pdfname=${11:-}',
  'private() { [ -L "$1" ] && { echo "cache folder $1 is a symbolic link" >&2; exit 1; }; mkdir -m 700 "$1" 2>/dev/null; [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || { echo "cache folder $1 is not ours" >&2; exit 1; }; chmod 700 "$1" || exit 1; }',
  'top="$base/filetree-preview-$(id -u)"',
  'private "$top"',
  'd="$top/$session"',
  'private "$d"',
  'printf "%s\\n" "$policy" > "$d/policy.xml" || exit 1',
  'out="$d/$name"',
  'tmp=$(mktemp "$d/.part.XXXXXX") || exit 1',
  'trap \'rm -f "$tmp"\' EXIT',
  'c=',
  'trap \'[ -n "$c" ] && kill "$c" 2>/dev/null; exit 143\' TERM INT HUP',
  'bg() { "$@" & c=$!; wait "$c"; r=$?; c=; return $r; }',
  'tried=',
  'pages=',
  'done_() { mv -f "$tmp" "$out" || exit 1; trap - EXIT; ls -t "$d" | grep "\\.png$" | tail -n +$((keep + 1)) | while read -r f; do rm -f "$d/$f"; done; printf "%s" "$out"; [ -n "$pages" ] && printf "\\n%s" "$pages"; exit 0; }',
  'scale="scale=\'min(1600,iw)\':\'min(1600,ih)\':force_original_aspect_ratio=decrease"',
  'if [ "$kind" = office ]; then',
  '  pdf="$d/$pdfname"',
  '  if [ ! -s "$pdf" ]; then',
  '    command -v soffice >/dev/null 2>&1 || { echo "no soffice on PATH to convert it" >&2; exit 3; }',
  '    conv=$(mktemp -d "$d/.conv.XXXXXX") || exit 1',
  '    trap \'rm -f "$tmp"; rm -rf "$conv"\' EXIT',
  '    bg timeout -k 2 20 soffice "-env:UserInstallation=file://$d/office" --headless --norestore --nologo --convert-to pdf --outdir "$conv" "$src" >/dev/null 2>&1',
  '    made=$(ls "$conv"/*.pdf 2>/dev/null | head -n1)',
  '    [ -n "$made" ] && [ -s "$made" ] || { echo "soffice could not convert it" >&2; exit 4; }',
  '    mv -f "$made" "$pdf" || exit 1',
  '    rm -rf "$conv"',
  '    trap \'rm -f "$tmp"\' EXIT',
  '    ls -t "$d" | grep "\\.pdf$" | tail -n +17 | while read -r f; do rm -f "$d/$f"; done',
  '  fi',
  '  src=$pdf kind=pdf',
  'fi',
  'if [ "$kind" = pdf ]; then',
  '  if command -v pdfinfo >/dev/null 2>&1; then',
  '    info=$(bg timeout -k 2 10 pdfinfo -- "$src" 2>&1)',
  '    case "$info" in *"Incorrect password"*|*"Command Line Error: Incorrect"*) echo "encrypted" >&2; exit 5;; esac',
  '    pages=$(printf "%s\\n" "$info" | sed -n "s/^Pages: *//p")',
  '  fi',
  '  if command -v pdftoppm >/dev/null 2>&1; then',
  '    tried=1',
  '    bg timeout -k 2 10 pdftoppm -png -f "$page" -l "$page" -singlefile -scale-to-x "$px" -scale-to-y -1 -- "$src" "$tmp.out" >/dev/null 2>&1 && [ -s "$tmp.out.png" ] && mv -f "$tmp.out.png" "$tmp" && done_',
  '    rm -f "$tmp.out.png"',
  '  fi',
  '  if command -v gs >/dev/null 2>&1; then',
  '    tried=1',
  '    bg timeout -k 2 10 gs -q -dSAFER -dBATCH -dNOPAUSE -sDEVICE=png16m "-dFirstPage=$page" "-dLastPage=$page" -r96 "-sOutputFile=$tmp" -- "$src" >/dev/null 2>&1 && [ -s "$tmp" ] && done_',
  '  fi',
  '  [ -n "$tried" ] && exit 4',
  '  echo "no pdftoppm or gs on PATH to draw it" >&2; exit 3',
  'fi',
  'if [ "$kind" = video ]; then',
  '  if command -v ffmpeg >/dev/null 2>&1; then',
  '    tried=1',
  '    ffmpeg -nostdin -v error -y -protocol_whitelist file -f "$coder" -ss 1 -i "file:$src" -an -sn -dn -frames:v 1 -vf "$scale" -f image2 -c:v png "$tmp" && [ -s "$tmp" ] && done_',
  '    ffmpeg -nostdin -v error -y -protocol_whitelist file -f "$coder" -i "file:$src" -an -sn -dn -frames:v 1 -vf "$scale" -f image2 -c:v png "$tmp" && [ -s "$tmp" ] && done_',
  '  fi',
  '  [ -n "$tried" ] && exit 4',
  '  echo "no ffmpeg on PATH for a poster frame" >&2; exit 3',
  'fi',
  'if command -v magick >/dev/null 2>&1; then tried=1; MAGICK_CONFIGURE_PATH="$d" magick -limit memory 256MiB -limit map 512MiB -limit area 128MP -limit width 32KP -limit height 32KP -limit time 20 "$coder:$src[0]" -auto-orient -resize "1600x1600>" "png:$tmp" && [ -s "$tmp" ] && done_; fi',
  'if command -v ffmpeg >/dev/null 2>&1; then tried=1; ffmpeg -nostdin -v error -y -protocol_whitelist file -f image2 -i "file:$src" -frames:v 1 -vf "$scale" -f image2 -c:v png "$tmp" && [ -s "$tmp" ] && done_; fi',
  '[ -n "$tried" ] && exit 4',
  'echo "no magick or ffmpeg on PATH to decode it" >&2; exit 3',
].join('\n')

export const CLEAN = 'd=$1; [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && rm -rf -- "$d"; exit 0'

export function coderFor(path: string): string {
  const ext = extension(path)
  return CODERS[ext] ?? DEMUXERS[ext] ?? DOCS[ext] ?? ''
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function pictureKind(path: string): 'png' | 'image' | 'video' | 'pdf' | 'office' | '' {
  const ext = extension(path)
  const doc = DOCS[ext]
  if (doc === 'pdf' || doc === 'office') return doc
  if (ext === 'png') return 'png'
  if (IMAGE.has(ext)) return 'image'
  return VIDEO.has(ext) ? 'video' : ''
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null
  const at = (i: number) => ((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0)
  const width = at(16) >>> 0
  const height = at(20) >>> 0
  return width && height ? { width, height } : null
}

export function fitCells(size: { width: number; height: number }, columns: number, rows: number): { columns: number; rows: number } {
  const cols = Math.max(1, Math.min(255, columns))
  const high = Math.max(1, Math.min(255, rows))
  const wide = Math.min(cols, Math.max(1, Math.round((high * 2 * size.width) / size.height)))
  return { columns: wide, rows: Math.max(1, Math.min(high, Math.round((wide * size.height) / (2 * size.width)))) }
}

function fnv(text: string, seed: number): string {
  let h = seed
  for (const ch of text) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function cacheName(path: string, mtime: number, size: number, page = 0, px = 0, ext = 'png'): string {
  const text = page ? `${path}\0${mtime}\0${size}\0${page}\0${px}` : `${path}\0${mtime}\0${size}`
  return `${fnv(text, 0x811c9dc5)}${fnv(text, 0x050c5d1f)}${fnv([...text].reverse().join(''), 0x2166136f)}${fnv(text, 0x9e3779b9)}.${ext}`
}
