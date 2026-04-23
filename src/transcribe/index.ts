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
import { extractAudio, getVideoDuration } from "../shared/utils.js";
import { cleanTranscript } from "./cleaner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function uploadToR2(payload: any, resultPath: string) {
  const PRIVATE_KEY = process.env.TRANSCODER_PRIVATE_KEY;
  const { target_r2_config } = payload;
  const ACCESS_KEY_ID = decrypt(target_r2_config.access_key_id, PRIVATE_KEY!);
  const SECRET_ACCESS_KEY = decrypt(target_r2_config.secret_access_key, PRIVATE_KEY!);
  const client = createR2Client(target_r2_config.endpoint, ACCESS_KEY_ID, SECRET_ACCESS_KEY);
  const transcriptKey = `${target_r2_config.prefix}/transcript.json`;
  
  await client.send(new PutObjectCommand({
    Bucket: target_r2_config.bucket,
    Key: transcriptKey,
    Body: readFileSync(resultPath),
    ContentType: "application/json",
  }));
  
  return `${target_r2_config.public_base_url.replace(/\/$/, "")}/${transcriptKey}`;
}

export async function runTranscriptionJob() {
  const payloadPath = process.argv[2];
  const mode = process.argv[3]; 

  if (!payloadPath) process.exit(1);
  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
  const jobId = payload.job_id || payload.lesson_id;
  const workingDir = path.join(os.tmpdir(), `transcribe-${jobId}-${Date.now()}`);

  try {
    await fs.mkdir(workingDir, { recursive: true });

    // --- MODE: WHISPER ---
    if (mode === "--whisper") {
      console.log(`🎙️ Running Whisper: ${jobId}`);
      const localVideo = path.join(workingDir, "video");
      const localAudio = path.join(workingDir, "audio.wav");
      const resultPath = path.join(workingDir, "raw.json");

      await sendCallback(payload.callback_url, { lessonId: payload.lesson_id, jobId: payload.job_id, status: "whisper_processing" }, payload.callback_client_id);

      const response = await fetch(payload.source_url);
      await pipeline(Readable.fromWeb(response.body! as any), createWriteStream(localVideo));
      const durationSeconds = await getVideoDuration(localVideo);
      await extractAudio(localVideo, localAudio);

      const whisperResult: any = await new Promise((resolve, reject) => {
        const pythonProcess = spawn("python3", [path.join(__dirname, "whisper_runner.py"), localAudio, payload.model_size || "medium", payload.initial_prompt || ""]);
        let stdout = "";
        pythonProcess.stdout.on("data", (d) => stdout += d);
        pythonProcess.stderr.on("data", (d) => process.stderr.write(d));
        pythonProcess.on("close", (c) => c === 0 ? resolve(JSON.parse(stdout)) : reject(new Error("Whisper engine failed")));
      });

      const finalResult = {
        jobId: payload.job_id, lessonId: payload.lesson_id,
        metadata: { title: payload.title, durationSeconds, model: payload.model_size, isCleaned: false },
        fullText: whisperResult.full_text,
        segments: whisperResult.segments
      };
      await fs.writeFile(resultPath, JSON.stringify(finalResult, null, 2));

      const transcriptUrl = await uploadToR2(payload, resultPath);
      await sendCallback(payload.callback_url, {
        lessonId: payload.lesson_id, jobId: payload.job_id, status: "whisper_success",
        transcriptUrl, fullText: finalResult.fullText, segments: finalResult.segments, metadata: finalResult.metadata
      }, payload.callback_client_id);
    }

    // --- MODE: CLEAN ---
    if (mode === "--clean") {
      console.log(`✨ Running Clean: ${jobId}`);
      if (!payload.raw) throw new Error("Missing 'raw' data");

      await sendCallback(payload.callback_url, { lessonId: payload.lesson_id, jobId: payload.job_id, status: "clean_processing" }, payload.callback_client_id);

      const { cleanedFullText, cleanedSegments, summary, keywords } = await cleanTranscript(payload.raw.segments);
      const finalSegments = cleanedSegments.filter((s: any) => s.text && s.text.trim().length > 0);
      const resultPath = path.join(workingDir, "cleaned.json");

      const finalResult = {
        jobId: payload.job_id, lessonId: payload.lesson_id,
        metadata: { title: payload.title, durationSeconds: payload.raw.duration_seconds, isCleaned: true, summary, keywords },
        fullText: cleanedFullText,
        rawFullText: payload.raw.full_text,
        segments: finalSegments,
        rawSegments: payload.raw.segments
      };

      await fs.writeFile(resultPath, JSON.stringify(finalResult, null, 2));
      const transcriptUrl = await uploadToR2(payload, resultPath);

      await sendCallback(payload.callback_url, {
        lessonId: payload.lesson_id, jobId: payload.job_id, status: "clean_success",
        transcriptUrl, fullText: finalResult.fullText, segments: finalResult.segments, metadata: finalResult.metadata
      }, payload.callback_client_id);
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    const status = mode === "--whisper" ? "whisper_failed" : "clean_failed";
    await sendCallback(payload.callback_url, { lessonId: payload.lesson_id, jobId: payload.job_id, status, error: error.message }, payload.callback_client_id);
    process.exit(1);
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTranscriptionJob();
}
