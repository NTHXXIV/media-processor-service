import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const PROMPT_TEMPLATE = (segmentsJson: string) => `
Bạn là một trợ lý AI chuyên nghiệp xử lý nội dung video.
NHIỆM VỤ:
1. LÀM SẠCH VĂN BẢN: Sửa lỗi chính tả, loại bỏ từ đệm, sửa câu lủng củng trong danh sách "segments" bên dưới.
2. TÓM TẮT: Viết một đoạn tóm tắt nội dung chính (khoảng 2-3 câu).
3. TỪ KHÓA: Trích xuất 5-7 từ khóa quan trọng nhất.

YÊU CẦU ĐẦU RA: Trả về duy nhất 1 JSON, không kèm giải thích.
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

async function cleanWithGemini(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No Gemini API Key");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
  
  const result = await model.generateContent(PROMPT_TEMPLATE(JSON.stringify(segments)));
  const text = result.response.text();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

async function cleanWithGroq(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No Groq API Key");

  const groq = new Groq({ apiKey });
  const completion = await groq.chat.completions.create({
    messages: [{ role: "user", content: PROMPT_TEMPLATE(JSON.stringify(segments)) }],
    model: "llama-3.3-70b-versatile", // Model mạnh nhất và hỗ trợ context lớn của Groq
    response_format: { type: "json_object" }
  });

  return JSON.parse(completion.choices[0]?.message?.content || "{}");
}

export async function cleanTranscript(segments: TranscriptSegment[]) {
  const rawFullText = segments.map(s => s.text).join(" ");
  
  // 1. Thử dùng Gemini trước
  try {
    console.log("💎 Attempting clean with Gemini...");
    return await cleanWithGemini(segments);
  } catch (geminiError: any) {
    console.warn(`⚠️ Gemini failed: ${geminiError.message}`);
    
    // 2. Fallback sang Groq nếu có Key
    if (process.env.GROQ_API_KEY) {
      try {
        console.log("🚀 Gemini failed or busy. Falling back to Groq (Llama 3)...");
        return await cleanWithGroq(segments);
      } catch (groqError: any) {
        console.error(`❌ Groq also failed: ${groqError.message}`);
      }
    }
  }

  // 3. Cuối cùng: Trả về bản thô nếu tất cả AI đều fail
  return {
    cleanedFullText: rawFullText,
    cleanedSegments: segments,
    summary: "",
    keywords: []
  };
}
