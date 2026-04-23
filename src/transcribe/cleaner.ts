import { GoogleGenerativeAI } from "@google/generative-ai";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

async function retryWithDelay(fn: () => Promise<any>, retries = 3, delay = 2000): Promise<any> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries <= 0 || (error.status !== 503 && error.status !== 429)) throw error;
    console.warn(`⚠️ Gemini API busy (status ${error.status}). Retrying in ${delay}ms... (${retries} left)`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return retryWithDelay(fn, retries - 1, delay * 2);
  }
}

export async function cleanTranscript(segments: TranscriptSegment[]): Promise<{ 
  cleanedFullText: string; 
  cleanedSegments: TranscriptSegment[];
  summary: string;
  keywords: string[];
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  const rawFullText = segments.map(s => s.text).join(" ");

  if (!apiKey) {
    console.warn("⚠️ GEMINI_API_KEY is not set. Skipping cleaning.");
    return { cleanedFullText: rawFullText, cleanedSegments: segments, summary: "", keywords: [] };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

    const prompt = `
Bạn là một trợ lý AI chuyên nghiệp xử lý nội dung video.
NHIỆM VỤ:
1. LÀM SẠCH VĂN BẢN: Sửa lỗi chính tả, loại bỏ từ đệm, sửa câu lủng củng trong danh sách "segments" bên dưới.
2. TÓM TẮT: Viết một đoạn tóm tắt nội dung chính (khoảng 2-3 câu).
3. TỪ KHÓA: Trích xuất 5-7 từ khóa quan trọng nhất.

YÊU CẦU ĐẦU RA: Trả về 1 JSON duy nhất, không kèm giải thích.
Cấu trúc JSON:
{
  "cleanedSegments": [{ "start": number, "end": number, "text": string }],
  "cleanedFullText": string,
  "summary": string,
  "keywords": [string]
}

INPUT JSON:
${JSON.stringify(segments)}
`;

    const result = await retryWithDelay(() => model.generateContent(prompt));
    const response = await result.response;
    const text = response.text();
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const output = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);

    return {
      cleanedFullText: output.cleanedFullText || rawFullText,
      cleanedSegments: output.cleanedSegments || segments,
      summary: output.summary || "",
      keywords: output.keywords || []
    };
  } catch (error: any) {
    console.error("❌ Error cleaning transcript with Gemini:", error.message || error);
    return { 
      cleanedFullText: rawFullText, 
      cleanedSegments: segments, 
      summary: "", 
      keywords: [] 
    }; 
  }
}
