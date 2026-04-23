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

export function validatePayload(payload: any) {
  const { lesson_id, source_url, target_r2_config } = payload;
  if (!lesson_id || !source_url || !target_r2_config) {
    throw new Error("Missing mandatory fields (lesson_id, source_url, target_r2_config)");
  }
}

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
  const stage = process.argv[3];

  if (!payloadPath) process.exit(1);
  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
  
  // Use job_id if available, otherwise fallback to lesson_id (which is mandatory)
  const jobId = payload.job_id || payload.lesson_id;
  const workingDir = path.join(os.tmpdir(), `transcribe-job-${jobId}`);
  
  const intermediatePath = path.join(workingDir, "intermediate.json");
  const resultJsonPath = path.join(workingDir, "transcript.json");

  try {
    validatePayload(payload);

    if (!stage || stage === "--stage=whisper") {
      console.log(`🎙️ Phase 1: Whisper started for job ${jobId}`);
      await fs.mkdir(workingDir, { recursive: true });
      
      try {
        await sendCallback(payload.callback_url, {
          lessonId: payload.lesson_id, jobId: payload.job_id, status: "processing",
        }, payload.callback_client_id);
      } catch (e) {
        console.error("⚠️ Initial callback failed, but continuing...");
      }

      const localVideo = path.join(workingDir, "source_video");
      const localAudio = path.join(workingDir, "audio.wav");
      
      const response = await fetch(payload.source_url);
      await pipeline(Readable.fromWeb(response.body! as any), createWriteStream(localVideo));
      const durationSeconds = await getVideoDuration(localVideo);
      await extractAudio(localVideo, localAudio);

      const whisperScript = path.join(__dirname, "whisper_runner.py");
      const whisperResult: any = await new Promise((resolve, reject) => {
        const pythonProcess = spawn("python3", [whisperScript, localAudio, payload.model_size || "medium", payload.initial_prompt || ""]);
        let stdout = "";
        pythonProcess.stdout.on("data", (data) => stdout += data.toString());
        pythonProcess.stderr.on("data", (data) => process.stderr.write(data));
        pythonProcess.on("close", (code) => {
          if (code !== 0) return reject(new Error("Whisper failed"));
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
        });
      });

      const initialResult = {
        jobId: payload.job_id, lessonId: payload.lesson_id,
        metadata: { title: payload.title, durationSeconds, model: payload.model_size, isCleaned: false },
        fullText: whisperResult.full_text,
        segments: whisperResult.segments
      };
      await fs.writeFile(resultJsonPath, JSON.stringify(initialResult, null, 2));
      await fs.writeFile(intermediatePath, JSON.stringify({ whisperResult, durationSeconds }));

      const transcriptUrl = await uploadToR2(payload, resultJsonPath);
      await sendCallback(payload.callback_url, {
        lessonId: payload.lesson_id, jobId: payload.job_id, status: "transcription_ready",
        transcriptUrl, fullText: initialResult.fullText, segments: initialResult.segments, metadata: initialResult.metadata
      }, payload.callback_client_id);
      
      console.log(`✅ Phase 1: Raw Transcription ready.`);
    }

    if (!stage || stage === "--stage=gemini") {
      console.log(`✨ Phase 2: AI Cleaning for job ${jobId}...`);
      
      let whisperResult: any;
      let durationSeconds: number;

      if (payload.raw_segments) {
        whisperResult = { segments: payload.raw_segments, language: payload.language || "vi", full_text: payload.raw_full_text || "" };
        durationSeconds = payload.duration_seconds || 0;
      } else {
        if (!readFileSync(intermediatePath)) throw new Error(`Intermediate file not found at ${intermediatePath}`);
        const intermediate = JSON.parse(readFileSync(intermediatePath, "utf-8"));
        whisperResult = intermediate.whisperResult;
        durationSeconds = intermediate.durationSeconds;
      }

      const { cleanedFullText, cleanedSegments, summary, keywords } = await cleanTranscript(whisperResult.segments);

      const finalResult = {
        jobId: payload.job_id, lessonId: payload.lesson_id,
        metadata: { title: payload.title, durationSeconds, isCleaned: true, summary, keywords },
        fullText: cleanedFullText,
        rawFullText: whisperResult.full_text,
        segments: cleanedSegments,
        rawSegments: whisperResult.segments
      };

      await fs.writeFile(resultJsonPath, JSON.stringify(finalResult, null, 2));
      const transcriptUrl = await uploadToR2(payload, resultJsonPath);

      await sendCallback(payload.callback_url, {
        lessonId: payload.lesson_id, jobId: payload.job_id, status: "transcription_cleaned",
        transcriptUrl, fullText: finalResult.fullText, segments: finalResult.segments, metadata: finalResult.metadata
      }, payload.callback_client_id);

      console.log(`✅ Phase 2: Cleaned Transcription updated.`);
    }

  } catch (error: any) {
    console.error(`❌ Job Failed: ${error?.message}`);
    if (!stage || stage === "--stage=whisper") {
      await sendCallback(payload.callback_url, {
        lessonId: payload.lesson_id, jobId: payload.job_id, status: "failed", error: error?.message,
      }, payload.callback_client_id);
    }
    process.exit(1);
  } finally {
    if (stage === "--stage=gemini") {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      try { await fs.unlink(payloadPath); } catch (e) {}
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTranscriptionJob();
}
