import { cleanTranscript } from './cleaner.js';

async function test() {
  console.log("🚀 Testing AI Cleaning System (Gemini + Groq Fallback)...");
  
  const mockSegments = [
    { start: 0, end: 5, text: "Chào mọi người, hôm nay chúng ta nói về bitcoin." },
    { start: 5, end: 10, text: "Xung quanh tiền ảo thì thường dính tới rượu tiền à ừm đúng không các bạn nhé." },
    { start: 10, end: 15, text: "Tuy nhiên hiện nay thì bitcoin là một trong những cái loại tài sản rất là ưu chuộng." }
  ];

  // 1. Kiểm tra ưu tiên Gemini (Nếu có key)
  if (process.env.GEMINI_API_KEY) {
    console.log("\n--- Testing Primary (Gemini) ---");
    try {
      const result = await cleanTranscript(mockSegments);
      console.log("✅ Result from Gemini:", result.cleanedFullText);
    } catch (e: any) {
      console.error("❌ Gemini failed:", e.message);
    }
  }

  // 2. Kiểm tra Groq (Giả lập Gemini lỗi bằng cách xóa tạm key trong env)
  if (process.env.GROQ_API_KEY) {
    console.log("\n--- Testing Fallback (Groq) ---");
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY; // Ép dùng fallback
    
    try {
      const result = await cleanTranscript(mockSegments);
      console.log("✅ Result from Groq:", result.cleanedFullText);
      console.log("📋 Summary:", result.summary);
      console.log("🏷️ Keywords:", result.keywords);
    } catch (e: any) {
      console.error("❌ Groq failed:", e.message);
    }
    
    process.env.GEMINI_API_KEY = originalGeminiKey; // Khôi phục
  }
}

test();
