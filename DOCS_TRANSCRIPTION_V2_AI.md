# Media Transcription Service V2 (AI Enhanced)

Hệ thống Transcription nâng cấp với kiến trúc **Tách rời (Decoupled)**, bộ **Status chuyên biệt**, và tích hợp **AI Fallback**.

---

## 1. Kiến trúc hệ thống
1.  **Whisper (Nghe):** Chuyển âm thanh -> văn bản thô. (Status: `whisper_*`)
2.  **Clean (AI):** Làm sạch văn bản + Tóm tắt. (Status: `clean_*`)

---

## 2. Luồng 1: Whisper (Chuyển đổi âm thanh)
### Input Payload
Gửi qua `repository_dispatch` (event_type: `build-transcription`). Không gửi kèm trường `stage`.

### Danh sách Status trả về:
*   **`whisper_processing`**: Đang xử lý tải video và chạy Whisper.
*   **`whisper_success`**: Thành công. Trả về bản thô (`fullText`, `segments`).
*   **`whisper_failed`**: Thất bại (Lỗi file, CPU quá tải...).

---

## 3. Luồng 2: Clean (Làm đẹp bằng AI)
### Input Payload
Gửi qua `repository_dispatch`. Bắt buộc có:
*   `stage: "clean"`
*   `raw: { segments, full_text, duration_seconds, language }`

### Danh sách Status trả về:
*   **`clean_processing`**: Đang gửi dữ liệu sang AI (Gemini/Groq).
*   **`clean_success`**: Thành công. Trả về bản đẹp (`fullText`, `segments`, `summary`, `keywords`).
*   **`clean_failed`**: Thất bại (Hết quota AI, nội dung không hợp lệ...).

---

## 4. Bảng tóm tắt Contract Dữ liệu (Callback)

| Trường dữ liệu | Giai đoạn Whisper | Giai đoạn Clean |
| :--- | :--- | :--- |
| **`status`** | `whisper_success` | `clean_success` |
| **`fullText`** | Văn bản thô | Văn bản ĐÃ LÀM SẠCH |
| **`segments`** | Subtitle thô | Subtitle ĐÃ LÀM SẠCH |
| **`metadata.summary`** | (không có) | Đoạn tóm tắt bài giảng |
| **`metadata.keywords`** | (không có) | Danh sách từ khóa |
| **`metadata.isCleaned`** | `false` | `true` |
| **`transcriptUrl`** | Link file thô trên R2 | Link file sạch trên R2 |

---

## 5. Hướng dẫn cho Backend
1.  **Lắng nghe `whisper_success`**: Lưu bản thô vào DB để User có thể xem ngay nội dung cơ bản.
2.  **Lắng nghe `clean_success`**: Ghi đè bản thô bằng bản sạch, hiển thị thêm Tóm tắt và Từ khóa.
3.  **Xử lý lỗi**: Nếu nhận được `whisper_failed`, báo đỏ cho Admin. Nếu `clean_failed`, có thể thử gửi lại yêu cầu Clean sau.
