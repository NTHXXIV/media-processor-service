# Hướng dẫn Tích hợp Luồng Transcription AI (Whisper + Gemini)

Tài liệu này hướng dẫn đội ngũ Backend (BE) cập nhật luồng gửi yêu cầu và nhận kết quả từ Media Processor Service phiên bản nâng cấp tích hợp Gemini AI.

---

## 1. Cấu hình GitHub (Dành cho Admin)
Để kích hoạt tính năng làm sạch văn bản, tóm tắt và trích xuất từ khóa, bạn **BẮT BUỘC** phải thêm API Key vào GitHub:
*   **Secret Name:** `GEMINI_API_KEY`
*   **Nguồn:** Lấy từ [Google AI Studio](https://aistudio.google.com/) (Hoàn toàn miễn phí).
*   **Cơ chế:** Nếu thiếu Key này, hệ thống sẽ tự động bỏ qua bước AI và chỉ trả về bản thô từ Whisper.

---

## 2. Gửi yêu cầu (Input Payload: BE -> GitHub)
Khi BE kích hoạt GitHub Action qua `repository_dispatch`, hãy lưu ý các cập nhật sau:

### A. Các trường dữ liệu mới (Khuyến nghị)
*   **`title` (String)**: Tiêu đề video (Ví dụ: "Tổng quan về thị trường chứng khoán"). Giúp Gemini hiểu ngữ cảnh để sửa lỗi chính tả chuyên môn chính xác hơn.
*   **`initial_prompt` (String)**: Gợi ý cho Whisper về ngôn ngữ và thuật ngữ (Ví dụ: "Video tiếng Việt về tài chính, VN-Index...").

### B. Chế độ "Chỉ làm sạch" (Clean-only)
Nếu bạn đã có bản thô (raw) và chỉ muốn AI làm sạch lại (mà không muốn chạy lại Whisper tốn 15-20 phút), hãy gửi payload với cấu trúc gọn gàng (đảm bảo không quá 10 top-level properties):
*   **`stage`**: Gán giá trị `"gemini"`.
*   **`raw`**: Object chứa dữ liệu thô:
    *   **`segments` (Array)**: Mảng các segment thô.
    *   **`full_text` (String)**: Văn bản thô.
    *   **`duration_seconds` (Number)**: Thời lượng video.
    *   **`language` (String)**: Mã ngôn ngữ (VD: "vi").

---

## 3. Nhận kết quả (Output Callback: GitHub -> BE)
Cấu trúc Body của POST request gửi về `callback_url` sau khi hoàn tất:

| Trường dữ liệu | Kiểu | Ý nghĩa & Cách xử lý |
| :--- | :--- | :--- |
| **`status`** | `String` | `"transcription_ready"` (Thành công) hoặc `"failed"` (Thất bại). |
| **`fullText`** | `String` | **Bản ĐÃ LÀM SẠCH (Cleaned)**: Đã sửa lỗi chính tả, ngắt đoạn, thêm dấu câu. **Lưu vào DB để hiển thị nội dung bài học.** |
| **`segments`** | `Array` | **Subtitle ĐÃ LÀM SẠCH**: Mảng JSON khớp thời gian video. **Lưu vào DB để làm phụ đề video.** |
| **`metadata.summary`** | `String` | **Tóm tắt AI**: 2-3 câu nội dung chính. **Hiển thị ở phần giới thiệu bài học.** |
| **`metadata.keywords`** | `Array` | **Từ khóa**: 5-7 tag quan trọng. **Dùng để gắn tag/SEO cho bài học.** |
| **`transcriptUrl`** | `String` | **Link R2**: File JSON chứa cả bản sạch và bản thô (backup) để audit. |

---

## 4. Cơ chế vận hành & Xử lý lỗi
*   **Kiến trúc 2 Job:** Quy trình trên GitHub được chia làm 2 Job: `Whisper Transcription` (nặng) và `Gemini Cleaning` (nhẹ). 
*   **Re-run thông minh:** Nếu Gemini lỗi (503 Quá tải), Admin có thể nhấn **"Re-run failed jobs"** trên GitHub. Hệ thống sẽ lấy lại kết quả Whisper đã xong và chỉ chạy lại phần AI (~30 giây) thay vì chạy lại từ đầu.
*   **Retry tự động:** Media Service có logic tự động thử lại 3 lần nếu Gemini báo bận (503/429).
*   **Bảo mật:** Payload nhạy cảm (R2 Keys) đã được ẩn hoàn toàn khỏi log công khai của GitHub.

---

## 5. Khuyến nghị cho Database (DB Design)
Để Frontend hoạt động mượt mà, BE nên lưu trữ các thông tin sau trực tiếp vào Database của bài học:
1.  **`content` (LongText)**: Lưu `payload.fullText`.
2.  **`summary` (Text)**: Lưu `payload.metadata.summary`.
3.  **`tags` (JSON)**: Lưu `payload.metadata.keywords`.
4.  **`subtitles` (JSON/LongText)**: Lưu mảng `payload.segments`.

Việc lưu trực tiếp giúp Frontend không cần phải gọi API đọc file từ R2 nhiều lần, giúp tăng tốc độ tải trang bài học.
