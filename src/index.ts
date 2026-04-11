import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import { constants, privateDecrypt } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  promises as fs,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function decrypt(encryptedValue: string, privateKey?: string): string {
  if (!privateKey) {
    console.warn("TRANSCODER_PRIVATE_KEY not set, using raw value.");
    return encryptedValue;
  }
  try {
    const buffer = Buffer.from(encryptedValue, "base64");
    return privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      buffer,
    ).toString("utf-8");
  } catch (e: any) {
    console.warn(`Decryption failed: ${e.message}. Using raw value.`);
    return encryptedValue;
  }
}

export function toSecretKey(id: string) {
  return `HLS_CALLBACK_SECRET_${id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

export function resolveCallbackSecret(
  callbackClientId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!callbackClientId) {
    const single = env.HLS_CALLBACK_SECRET;
    if (!single) throw new Error("Missing HLS_CALLBACK_SECRET");
    return single;
  }

  const envKey = toSecretKey(callbackClientId);
  const secret = env[envKey];
  if (!secret) {
    throw new Error(`Missing callback secret env: ${envKey}`);
  }
  return secret;
}

export async function sendCallback(
  callbackUrl: string | undefined,
  body: Record<string, unknown>,
  callbackClientId?: string,
) {
  if (!callbackUrl) return;
  try {
    const callbackSecret = resolveCallbackSecret(callbackClientId);

    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hls-callback-secret": callbackSecret,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`Callback failed ${res.status}: ${txt}`);
    }
  } catch (error) {
    console.warn(`Callback request failed:`, error);
  }
}

export async function cleanupPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
) {
  const listPrefix = `${prefix.replace(/\/$/, "")}/`;

  while (true) {
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: listPrefix,
      }),
    );

    const objects = listResponse.Contents ?? [];
    if (objects.length === 0) {
      break;
    }

    for (let index = 0; index < objects.length; index += 1000) {
      const chunk = objects.slice(index, index + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: chunk
              .filter((object) => object.Key)
              .map((object) => ({ Key: object.Key! })),
            Quiet: true,
          },
        }),
      );
    }

    if (!listResponse.IsTruncated) {
      break;
    }
  }
}

export type Variant = {
  name: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  maxRateKbps: number;
  audioBitrateKbps: number;
};

export const VARIANT_CATALOG: Variant[] = [
  {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrateKbps: 1400,
    maxRateKbps: 1600,
    audioBitrateKbps: 96,
  },
  {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrateKbps: 2800,
    maxRateKbps: 3200,
    audioBitrateKbps: 128,
  },
  {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrateKbps: 5000,
    maxRateKbps: 5600,
    audioBitrateKbps: 160,
  },
];

export function buildMasterPlaylist(variants: Variant[]) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const v of variants)
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.maxRateKbps * 1000},RESOLUTION=${v.width}x${v.height},NAME="${v.name}"`,
      `${v.name}.m3u8`,
    );
  return lines.join("\n") + "\n";
}

export async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (e) => {
      const res = path.resolve(dir, e.name);
      return e.isDirectory() ? listFilesRecursive(res) : [res];
    }),
  );
  return files.flat();
}

export function getContentType(p: string) {
  if (p.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (p.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

async function createHlsRenditions(
  inputPath: string,
  outputDir: string,
  variants: Variant[],
  segmentSeconds: number,
) {
  if (variants.length === 0) throw new Error("No variants specified");
  const encoder = "libx264";
  const args = ["-y", "-i", inputPath];
  let filterComplex =
    variants.length > 1 ? `[0:v]split=${variants.length}` : `[0:v]copy[vs0];`;
  if (variants.length > 1) {
    for (let i = 0; i < variants.length; i++) filterComplex += `[vs${i}]`;
    filterComplex += ";";
  }
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    filterComplex += `[vs${i}]scale=w=${v.width}:h=${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2[v${i}out]`;
    if (i < variants.length - 1) filterComplex += ";";
  }
  args.push("-filter_complex", filterComplex);
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]!;
    args.push(
      "-map",
      `[v${i}out]`,
      "-map",
      "0:a:0?",
      `-c:v:${i}`,
      encoder,
      `-b:v:${i}`,
      `${v.videoBitrateKbps}k`,
      `-maxrate:v:${i}`,
      `${v.maxRateKbps}k`,
      `-bufsize:v:${i}`,
      `${v.maxRateKbps * 2}k`,
      `-preset:v:${i}`,
      "veryfast",
      `-profile:v:${i}`,
      "main",
      `-g:v:${i}`,
      "48",
    );
  }
  const streamMap = variants
    .map((v, i) => `v:${i},a:${i},name:${v.name}`)
    .join(" ");
  args.push(
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    path.join(outputDir, "%v_%05d.ts"),
    "-var_stream_map",
    streamMap,
    path.join(outputDir, "%v.m3u8"),
  );

  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "inherit" });
    child.on("close", (code: number) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)),
    );
  });
}

export async function runTranscode() {
  // Đọc payload từ file (được GitHub Action ghi ra)
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    console.error("Missing payload path");
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
  const PRIVATE_KEY = process.env.TRANSCODER_PRIVATE_KEY;

  // Map các giá trị từ payload
  const SOURCE_URL = payload.source_url;
  const LESSON_ID =
    typeof payload.lesson_id === "string" ? payload.lesson_id.trim() : "";
  const CALLBACK_CLIENT_ID = payload.callback_client_id;
  const TARGET_R2_CONFIG = payload.target_r2_config;
  const VARIANTS_CSV = payload.variants || "480p,720p";
  const CALLBACK_URL = payload.callback_url;
  const SEGMENT_SECONDS = Number(payload.segment_seconds) || 6;

  if (!LESSON_ID) {
    console.error("❌ Error: Missing or invalid payload.lesson_id");
    process.exit(1);
  }

  // Giải mã Key R2 nếu chúng được mã hóa
  const ACCESS_KEY_ID = decrypt(TARGET_R2_CONFIG.access_key_id, PRIVATE_KEY);
  const SECRET_ACCESS_KEY = decrypt(
    TARGET_R2_CONFIG.secret_access_key,
    PRIVATE_KEY,
  );

  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
    console.error(
      "❌ Error: R2 Credentials are missing or could not be decrypted.",
    );
    process.exit(1);
  }

  // Check if it looks like it's still encrypted (too long for a standard access key)
  if (ACCESS_KEY_ID.length > 100) {
    console.error(
      "❌ Error: ACCESS_KEY_ID seems to be still encrypted or invalid. Check TRANSCODER_PRIVATE_KEY.",
    );
    process.exit(1);
  }

  const SELECTED_VARIANTS = VARIANT_CATALOG.filter((v) =>
    VARIANTS_CSV.split(",").includes(v.name),
  );

  console.log(`🎬 Job started for: ${SOURCE_URL}`);
  await sendCallback(CALLBACK_URL, {
    lessonId: LESSON_ID,
    status: "processing",
  }, CALLBACK_CLIENT_ID);

  const client = new S3Client({
    region: "auto",
    endpoint: TARGET_R2_CONFIG.endpoint,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), `hls-job-`));
  const localSource = path.join(workingDir, "source.mp4");

  try {
    console.log(`📥 Downloading source...`);
    const response = await fetch(SOURCE_URL);
    if (!response.ok)
      throw new Error(`Download failed: ${response.statusText}`);
    await pipeline(
      Readable.fromWeb(response.body! as any),
      createWriteStream(localSource),
    );

    await createHlsRenditions(
      localSource,
      workingDir,
      SELECTED_VARIANTS,
      SEGMENT_SECONDS,
    );

    const masterPlaylist = buildMasterPlaylist(SELECTED_VARIANTS);
    await fs.writeFile(path.join(workingDir, "master.m3u8"), masterPlaylist);

    console.log(`☁️  Uploading to R2...`);
    console.log(
      `🧹 Cleaning existing objects under prefix: ${TARGET_R2_CONFIG.prefix}`,
    );
    await cleanupPrefix(
      client,
      TARGET_R2_CONFIG.bucket,
      TARGET_R2_CONFIG.prefix,
    );

    const files = await listFilesRecursive(workingDir);
    const uploadedKeys: string[] = [];
    for (const filePath of files) {
      if (filePath === localSource) continue;
      const relativePath = path
        .relative(workingDir, filePath)
        .replace(/\\/g, "/");
      const key = `${TARGET_R2_CONFIG.prefix}/${relativePath}`;
      await client.send(
        new PutObjectCommand({
          Bucket: TARGET_R2_CONFIG.bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: getContentType(filePath),
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
      uploadedKeys.push(key);
    }

    const masterUrl = `${TARGET_R2_CONFIG.public_base_url.replace(/\/$/, "")}/${TARGET_R2_CONFIG.prefix}/master.m3u8`;
    if (!masterUrl.startsWith("https://")) {
      throw new Error("hlsManifestUrl must be an HTTPS URL");
    }
    console.log(`✅ Success: ${masterUrl}`);
    await sendCallback(CALLBACK_URL, {
      lessonId: LESSON_ID,
      status: "ready",
      hlsManifestUrl: masterUrl,
      hlsVersion: "v2",
      prefix: TARGET_R2_CONFIG.prefix,
      files: uploadedKeys,
      generatedAt: new Date().toISOString(),
      sourceMp4Url: SOURCE_URL,
    }, CALLBACK_CLIENT_ID);
  } catch (error) {
    console.error(`❌ Failed:`, error);
    try {
      await sendCallback(CALLBACK_URL, {
        lessonId: LESSON_ID,
        status: "failed",
        error: String(error instanceof Error ? error.message : error),
      }, CALLBACK_CLIENT_ID);
    } catch (callbackError) {
      console.error(`❌ Failure callback also failed:`, callbackError);
    } finally {
      process.exit(1);
    }
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true });
  }
}

// Only run if this file is the main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  runTranscode();
}
