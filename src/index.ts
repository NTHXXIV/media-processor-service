import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, promises as fs, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { privateDecrypt } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

// Đọc payload từ file (được GitHub Action ghi ra)
const payloadPath = process.argv[2]
if (!payloadPath) {
  console.error('Missing payload path')
  process.exit(1)
}

const payload = JSON.parse(readFileSync(payloadPath, 'utf-8'))
const PRIVATE_KEY = process.env.TRANSCODER_PRIVATE_KEY

function decrypt(encryptedValue: string): string {
  if (!PRIVATE_KEY) return encryptedValue
  try {
    const buffer = Buffer.from(encryptedValue, 'base64')
    return privateDecrypt(
      {
        key: PRIVATE_KEY,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    ).toString('utf-8')
  } catch (e) {
    console.warn('Decryption failed, using raw value.')
    return encryptedValue
  }
}

// Map các giá trị từ payload
const SOURCE_URL = payload.source_url
const TARGET_R2_CONFIG = payload.target_r2_config
const VARIANTS_CSV = payload.variants || '480p,720p'
const CALLBACK_URL = payload.callback_url
const SEGMENT_SECONDS = Number(payload.segment_seconds) || 6

// Giải mã Key R2 nếu chúng được mã hóa
const ACCESS_KEY_ID = decrypt(TARGET_R2_CONFIG.access_key_id)
const SECRET_ACCESS_KEY = decrypt(TARGET_R2_CONFIG.secret_access_key)

type Variant = {
  name: string; width: number; height: number;
  videoBitrateKbps: number; maxRateKbps: number; audioBitrateKbps: number;
}

const VARIANT_CATALOG: Variant[] = [
  { name: '480p', width: 854, height: 480, videoBitrateKbps: 1400, maxRateKbps: 1600, audioBitrateKbps: 96 },
  { name: '720p', width: 1280, height: 720, videoBitrateKbps: 2800, maxRateKbps: 3200, audioBitrateKbps: 128 },
  { name: '1080p', width: 1920, height: 1080, videoBitrateKbps: 5000, maxRateKbps: 5600, audioBitrateKbps: 160 },
]

const SELECTED_VARIANTS = VARIANT_CATALOG.filter(v => VARIANTS_CSV.split(',').includes(v.name))

async function runTranscode() {
  console.log(`🎬 Job started for: ${SOURCE_URL}`)
  
  const client = new S3Client({
    region: 'auto',
    endpoint: TARGET_R2_CONFIG.endpoint,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  })

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), `hls-job-`))
  const localSource = path.join(workingDir, 'source.mp4')

  try {
    console.log(`📥 Downloading source...`)
    const response = await fetch(SOURCE_URL)
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`)
    await pipeline(Readable.fromWeb(response.body! as any), createWriteStream(localSource))

    await createHlsRenditions(localSource, workingDir, SELECTED_VARIANTS)
    
    const masterPlaylist = buildMasterPlaylist(SELECTED_VARIANTS)
    await fs.writeFile(path.join(workingDir, 'master.m3u8'), masterPlaylist)

    console.log(`☁️  Uploading to R2...`)
    const files = await listFilesRecursive(workingDir)
    for (const filePath of files) {
       if (filePath === localSource) continue
       const relativePath = path.relative(workingDir, filePath).replace(/\\/g, '/')
       const key = `${TARGET_R2_CONFIG.prefix}/${relativePath}`
       await client.send(new PutObjectCommand({
         Bucket: TARGET_R2_CONFIG.bucket,
         Key: key,
         Body: createReadStream(filePath),
         ContentType: getContentType(filePath),
         CacheControl: 'public, max-age=31536000, immutable',
       }))
    }

    const masterUrl = `${TARGET_R2_CONFIG.public_base_url.replace(/\/$/, '')}/${TARGET_R2_CONFIG.prefix}/master.m3u8`
    console.log(`✅ Success: ${masterUrl}`)

    if (CALLBACK_URL) {
      await fetch(CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'success', master_url: masterUrl, variants: SELECTED_VARIANTS.map(v => v.name) })
      })
    }
  } catch (error) {
    console.error(`❌ Failed:`, error)
    if (CALLBACK_URL) {
       await fetch(CALLBACK_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ status: 'error', error: String(error) })
       })
    }
    process.exit(1)
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true })
  }
}

async function createHlsRenditions(inputPath: string, outputDir: string, variants: Variant[]) {
  const encoder = 'libx264'
  const args = ['-y', '-i', inputPath]
  let filterComplex = variants.length > 1 ? `[0:v]split=${variants.length}` : `[0:v]copy[vs0];`
  if (variants.length > 1) {
    for (let i = 0; i < variants.length; i++) filterComplex += `[vs${i}]`
    filterComplex += ';'
  }
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    filterComplex += `[vs${i}]scale=w=${v.width}:h=${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2[v${i}out]`
    if (i < variants.length - 1) filterComplex += ';'
  }
  args.push('-filter_complex', filterComplex)
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    args.push('-map', `[v${i}out]`, '-map', '0:a:0?', `-c:v:${i}`, encoder, `-b:v:${i}`, `${v.videoBitrateKbps}k`, `-maxrate:v:${i}`, `${v.maxRateKbps}k`, `-bufsize:v:${i}`, `${v.maxRateKbps * 2}k`, `-preset:v:${i}`, 'veryfast', `-profile:v:${i}`, 'main', `-g:v:${i}`, '48')
  }
  const streamMap = variants.map((v, i) => `v:${i},a:${i},name:${v.name}`).join(' ')
  args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000', '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(outputDir, '%v_%05d.ts'), '-var_stream_map', streamMap, path.join(outputDir, '%v.m3u8'))

  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'inherit' })
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)))
  })
}

function buildMasterPlaylist(variants: Variant[]) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const v of variants) lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.maxRateKbps * 1000},RESOLUTION=${v.width}x${v.height},NAME="${v.name}"`, `${v.name}.m3u8`)
  return lines.join('\n') + '\n'
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(entries.map(e => {
    const res = path.resolve(dir, e.name)
    return e.isDirectory() ? listFilesRecursive(res) : [res]
  }))
  return files.flat()
}

function getContentType(p: string) {
  if (p.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (p.endsWith('.ts')) return 'video/mp2t'
  return 'application/octet-stream'
}

runTranscode()
