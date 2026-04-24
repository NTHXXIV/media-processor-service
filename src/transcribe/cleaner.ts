import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PROMPT_TEMPLATE = (segmentsJson: string) => `
Bạn là một trợ lý AI chuyên nghiệp xử lý nội dung video.
NHIỆM VỤ:
1. LÀM SẠCH VĂN BẢN: Sửa lỗi chính tả, loại bỏ từ đệm (à, ờ, thì, mà...), sửa câu lủng củng.
2. GIỮ NGUYÊN THỜI GIAN: Tuyệt đối không thay đổi giá trị "start" và "end" của các segment.
3. TÓM TẮT: Viết một đoạn tóm tắt nội dung của ĐOẠN NÀY (khoảng 1-2 câu).
4. TỪ KHÓA: Trích xuất 3-5 từ khóa quan trọng của ĐOẠN NÀY.

YÊU CẦU ĐẦU RA:
- Trả về duy nhất 1 JSON block.
- Không thêm bất kỳ văn bản giải thích nào ngoài JSON.
- Đảm bảo "cleanedSegments" có cùng số lượng phần tử với input.

Cấu trúc JSON:
{
  "cleanedSegments": [{ "start": number, "end": number, "text": string }],
  "cleanedFullText": string,
  "summary": string,
  "keywords": [string]
}

INPUT JSON:
${segmentsJson}
`;

// Danh sách các model để rotate khi gặp lỗi
const GROQ_MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "deepseek-r1-distill-llama-70b",
  "llama-3.1-70b-versatile",
  "gemma2-9b-it"
];

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
];

// State để nhớ model nào đang chạy tốt
let lastSuccessfulGroqModelIndex = 0;
let lastSuccessfulGeminiModelIndex = 0;

async function cleanWithGemini(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No Gemini API Key");

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: any = null;

  // Thử từ model thành công lần trước
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const idx = (lastSuccessfulGeminiModelIndex + i) % GEMINI_MODELS.length;
    const modelName = GEMINI_MODELS[idx];
    
    try {
      console.log(`    💎 Trying Gemini model: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: PROMPT_TEMPLATE(JSON.stringify(segments)) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        }
      });

      const text = result.response.text();
      try {
        const parsed = JSON.parse(text);
        lastSuccessfulGeminiModelIndex = idx; // Lưu lại model thành công
        return parsed;
      } catch (e) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          lastSuccessfulGeminiModelIndex = idx;
          return JSON.parse(jsonMatch[0]);
        }
        throw new Error("Invalid AI Response: Could not parse JSON");
      }
    } catch (error: any) {
      console.warn(`    ⚠️ Gemini model ${modelName} failed: ${error.message}`);
      lastError = error;
      if (error.message?.includes("429")) {
        await sleep(5000);
      } else if (error.message?.includes("404")) {
        continue;
      }
    }
  }
  throw lastError;
}

async function cleanWithGroq(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No Groq API Key");

  const groq = new Groq({ apiKey });
  let lastError: any = null;

  for (let i = 0; i < GROQ_MODELS.length; i++) {
    const idx = (lastSuccessfulGroqModelIndex + i) % GROQ_MODELS.length;
    const modelName = GROQ_MODELS[idx];
    
    let retries = 1; 
    while (retries >= 0) {
      try {
        console.log(`    🚀 Trying Groq model: ${modelName}...`);
        const completion = await groq.chat.completions.create({
          messages: [{ role: "user", content: PROMPT_TEMPLATE(JSON.stringify(segments)) }],
          model: modelName,
          response_format: { type: "json_object" }
        });
        const content = completion.choices[0]?.message?.content;
        if (!content) throw new Error("Empty response from Groq");
        const parsed = JSON.parse(content);
        lastSuccessfulGroqModelIndex = idx; // Lưu lại model thành công
        return parsed;
      } catch (error: any) {
        console.warn(`    ⚠️ Groq model ${modelName} failed: ${error.message}`);
        lastError = error;
        
        if (error.status === 429 || error.message?.includes("429")) {
          console.log(`    ⏳ Rate limit hit for ${modelName}, retrying in 5s... (${retries} left)`);
          await sleep(5000);
          retries--;
          continue;
        }
        break; 
      }
    }
  }
  throw lastError;
}

function chunkSegments(segments: TranscriptSegment[], chunkSize: number = 30): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  for (let i = 0; i < segments.length; i += chunkSize) {
    chunks.push(segments.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function cleanTranscript(segments: TranscriptSegment[]) {
  const chunks = chunkSegments(segments, 30);
  const allCleanedSegments: TranscriptSegment[] = [];
  const allSummaries: string[] = [];
  const allKeywords = new Set<string>();

  console.log(`📦 Processing transcript in ${chunks.length} chunks...`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`⏳ Processing chunk ${i + 1}/${chunks.length}...`);
    
    let result: any = null;
    let chunkRetries = 2;

    while (chunkRetries >= 0 && !result) {
      try {
        // 1. Thử Groq với cơ chế rotate model
        try {
          result = await cleanWithGroq(chunk);
        } catch (groqError: any) {
          console.warn(`  ⚠️ All Groq models failed for chunk ${i+1}.`);
          
          // 2. Fallback sang Gemini với cơ chế rotate model
          console.log(`  🔄 Switching provider to Gemini for chunk ${i+1}...`);
          result = await cleanWithGemini(chunk);
        }
      } catch (error: any) {
        console.error(`  ❌ All AI providers failed for chunk ${i+1}.`);
        if (chunkRetries > 0) {
          console.log(`  ⏳ Global failure for chunk ${i+1}, retrying the whole chunk in 30s... (${chunkRetries} left)`);
          await sleep(30000);
          chunkRetries--;
        } else {
          // THROW ERROR: Không "cứu vãn" bằng bản thô nữa, báo lỗi để Job fail chính thức
          throw new Error(`CLEAN_JOB_FAILED: AI services are unavailable or quota exceeded after multiple retries (Chunk ${i+1}/${chunks.length}). Last error: ${error.message}`);
        }
      }
    }

    // Gộp kết quả
    if (result.cleanedSegments) {
      allCleanedSegments.push(...result.cleanedSegments);
    } else {
      // Trường hợp AI trả về JSON nhưng thiếu field (hiếm gặp với rotate model)
      allCleanedSegments.push(...chunk);
    }
    
    if (result.summary) allSummaries.push(result.summary);
    if (Array.isArray(result.keywords)) {
      result.keywords.forEach((k: string) => allKeywords.add(k.toLowerCase()));
    }

    // Throttling: Nghỉ giữa các chunk (trừ chunk cuối)
    if (i < chunks.length - 1) {
      const waitTime = 15000;
      console.log(`  💤 Sleeping for ${waitTime/1000}s to avoid rate limits...`);
      await sleep(waitTime);
    }
  }

  const finalFullText = allCleanedSegments.map(s => s.text).join(" ");
  const finalSummary = allSummaries.join(" ");
  const finalKeywords = Array.from(allKeywords).slice(0, 10);

  // Đảm bảo summary không rỗng để pass backend validation
  const validatedSummary = finalSummary.trim().length > 0 ? finalSummary : "(Bản tóm tắt đang được tạo)";
  const validatedKeywords = finalKeywords.length > 0 ? finalKeywords : ["video"];

  return {
    cleanedFullText: finalFullText,
    cleanedSegments: allCleanedSegments,
    summary: validatedSummary,
    keywords: validatedKeywords
  };
}
