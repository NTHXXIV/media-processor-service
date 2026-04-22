import { PutObjectCommand } from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  promises as fs,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { decrypt } from "../shared/crypto.js";
import { sendCallback, validateCallbackUrl } from "../shared/callback.js";
import { createR2Client } from "../shared/r2.js";
import { extractAudio, getContentType, getVideoDuration } from "../shared/utils.js";
import { cleanTranscript } from "./cleaner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runTranscriptionJob() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    console.error("Missing payload path");
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
  const PRIVATE_KEY = process.env.TRANSCODER_PRIVATE_KEY;

  const SOURCE_URL = payload.source_url;
  const TITLE = payload.title || "";
  const LESSON_ID = typeof payload.lesson_id === "string" ? payload.lesson_id.trim() : "";
  const CALLBACK_CLIENT_ID = payload.callback_client_id;
  const TARGET_R2_CONFIG = payload.target_r2_config;
  const CALLBACK_URL = payload.callback_url;
  const MODEL_SIZE = payload.model_size || "medium";
  const SOURCE_VERSION = payload.source_version;
  const JOB_ID = payload.job_id;

  if (!LESSON_ID || !SOURCE_URL || !TARGET_R2_CONFIG) {
    console.error("❌ Error: Missing mandatory payload fields (lesson_id, source_url, target_r2_config)");
    process.exit(1);
  }

  // --- SECURITY VALIDATIONS ---
  // 1. Validate Prefix: Must contain lesson_id to isolate data
  if (!TARGET_R2_CONFIG.prefix || TARGET_R2_CONFIG.prefix === "/" || !TARGET_R2_CONFIG.prefix.includes(LESSON_ID)) {
    console.error("❌ Security Error: prefix is invalid or does not contain lesson_id.");
    process.exit(1);
  }

  // 2. Validate R2 Endpoint: Only accept Cloudflare R2
  try {
    const endpointUrl = new URL(TARGET_R2_CONFIG.endpoint);
    if (!endpointUrl.hostname.endsWith(".r2.cloudflarestorage.com")) {
      throw new Error(`Invalid R2 endpoint domain: ${endpointUrl.hostname}`);
    }
  } catch (e: any) {
    console.error(`❌ Security Error: ${e.message}`);
    process.exit(1);
  }

  // 3. Validate Callback URL: Prevent leaking secret to unauthorized domains
  if (CALLBACK_URL) {
    try {
      validateCallbackUrl(CALLBACK_URL);
    } catch (e: any) {
      console.error(`❌ Security Error: ${e.message}`);
      process.exit(1);
    }
  }

  // 4. Validate Source URL: Prevent SSRF
  try {
    const sUrl = new URL(SOURCE_URL);
    if (sUrl.hostname === "localhost" || sUrl.hostname.startsWith("127.") || sUrl.hostname.startsWith("169.254.")) {
      throw new Error("Potential SSRF detected in source_url");
    }
  } catch (e: any) {
    console.error(`❌ Security Error: ${e.message}`);
    process.exit(1);
  }
  // --- END SECURITY VALIDATIONS ---

  // Decrypt R2 Keys
  const ACCESS_KEY_ID = decrypt(TARGET_R2_CONFIG.access_key_id, PRIVATE_KEY);
  const SECRET_ACCESS_KEY = decrypt(TARGET_R2_CONFIG.secret_access_key, PRIVATE_KEY);

  console.log(`🎙️ Transcription Job started for: ${SOURCE_URL}`);
  
  // Status: Processing
  await sendCallback(CALLBACK_URL, {
    lessonId: LESSON_ID,
    jobId: JOB_ID,
    sourceVersion: SOURCE_VERSION,
    status: "processing",
  }, CALLBACK_CLIENT_ID);

  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), `transcribe-job-`));
  const localVideo = path.join(workingDir, "source_video");
  const localAudio = path.join(workingDir, "audio.wav");
  const resultJsonPath = path.join(workingDir, "transcript.json");

  try {
    // 1. Download source
    console.log(`📥 Downloading source...`);
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
    await pipeline(Readable.fromWeb(response.body! as any), createWriteStream(localVideo));

    const durationSeconds = await getVideoDuration(localVideo);

    // 2. Extract Audio (16kHz mono wav for Whisper)
    console.log(`🎵 Extracting audio...`);
    await extractAudio(localVideo, localAudio);

    // 3. Run Whisper
    console.log(`🤖 Running Whisper (${MODEL_SIZE})...`);
    
    // Default prompt focusing on common Vietnamese filler words and basic English tech terms
    const genericFallbackPrompt = "Chào mọi người, trong video này chúng ta sẽ nói về... OK, yeah, video, micro, slide, trình bày, nội dung, ví dụ như là, các bạn nhé.";
    const initialPrompt = payload.initial_prompt || genericFallbackPrompt;
    
    const whisperScript = path.join(__dirname, "whisper_runner.py");
    
    const whisperResult = await new Promise((resolve, reject) => {
      const pythonArgs = [whisperScript, localAudio, MODEL_SIZE, initial_prompt];
      const pythonProcess = spawn("python3", pythonArgs);
      let stdout = "";

      pythonProcess.stdout.on("data", (data) => stdout += data.toString());
      // Pipe stderr to main stderr to see progress in real-time
      pythonProcess.stderr.on("data", (data) => process.stderr.write(data));

      pythonProcess.on("close", (code) => {
        if (code !== 0) return reject(new Error(`Whisper failed with code ${code}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error("Failed to parse Whisper JSON output"));
        }
      });
    });


    // 4. Structure & Clean result
    console.log(`✨ Cleaning transcript with Gemini...`);
    const rawSegments = (whisperResult as any).segments;
    const { cleanedFullText, cleanedSegments, summary, keywords } = await cleanTranscript(rawSegments);

    const finalResult = {
      jobId: JOB_ID,
      lessonId: LESSON_ID,
      metadata: {
        title: TITLE,
        language: (whisperResult as any).language,
        durationSeconds: durationSeconds || (whisperResult as any).duration,
        model: MODEL_SIZE,
        generatedAt: new Date().toISOString(),
        isCleaned: !!process.env.GEMINI_API_KEY,
        summary,
        keywords
      },
      fullText: cleanedFullText,
      rawFullText: (whisperResult as any).full_text,
      segments: cleanedSegments,
      rawSegments: rawSegments
    };

    await fs.writeFile(resultJsonPath, JSON.stringify(finalResult, null, 2));

    // 5. Upload to R2
    console.log(`☁️ Uploading transcript to R2...`);
    const client = createR2Client(TARGET_R2_CONFIG.endpoint, ACCESS_KEY_ID, SECRET_ACCESS_KEY);
    const transcriptKey = `${TARGET_R2_CONFIG.prefix}/transcript.json`;
    
    await client.send(new PutObjectCommand({
      Bucket: TARGET_R2_CONFIG.bucket,
      Key: transcriptKey,
      Body: readFileSync(resultJsonPath),
      ContentType: "application/json",
      CacheControl: "public, max-age=31536000, immutable",
    }));

    const transcriptUrl = `${TARGET_R2_CONFIG.public_base_url.replace(/\/$/, "")}/${transcriptKey}`;
    console.log(`✅ Success: ${transcriptUrl}`);

    // 6. Final Callback
    await sendCallback(CALLBACK_URL, {
      lessonId: LESSON_ID,
      jobId: JOB_ID,
      sourceVersion: SOURCE_VERSION,
      status: "transcription_ready",
      transcriptUrl,
      fullText: finalResult.fullText, 
      segments: finalResult.segments, // Bản sạch cho Subtitle
      metadata: finalResult.metadata
    }, CALLBACK_CLIENT_ID);

  } catch (error: any) {
    console.error(`❌ Transcription Failed: ${error?.message}`);
    await sendCallback(CALLBACK_URL, {
      lessonId: LESSON_ID,
      jobId: JOB_ID,
      sourceVersion: SOURCE_VERSION,
      status: "failed",
      error: String(error?.message || error),
    }, CALLBACK_CLIENT_ID);
    process.exit(1);
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(payloadPath).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTranscriptionJob();
}
