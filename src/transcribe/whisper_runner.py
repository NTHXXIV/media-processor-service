import sys
import json
import os
from faster_whisper import WhisperModel

def transcribe(audio_path, model_size="base", initial_prompt=None):
    # Cấu hình tối ưu cho CPU GitHub Actions (2 vCPU)
    # cpu_threads=2 giúp tránh tranh chấp tài nguyên
    model = WhisperModel(
        model_size, 
        device="cpu", 
        compute_type="int8", 
        cpu_threads=2, 
        num_workers=1
    )
    
    # Bật tính năng log tiến độ ra stderr để Node.js bắt được
    segments, info = model.transcribe(
        audio_path, 
        beam_size=5, 
        initial_prompt=initial_prompt
    )
    
    print(f"DEBUG: Detected language {info.language} with probability {info.language_probability:.2f}", file=sys.stderr)
    
    results = []
    for segment in segments:
        # In tiến độ ra stderr để người dùng không cảm thấy bị kẹt
        percent = (segment.end / info.duration) * 100 if info.duration > 0 else 0
        print(f"PROGRESS: {percent:.1f}% transcribed ({segment.end:.1f}s / {info.duration:.1f}s)", file=sys.stderr)
        
        results.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip()
        })
        
    return {
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
        "segments": results,
        "full_text": " ".join([s["text"] for s in results])
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing audio path"}))
        sys.exit(1)
        
    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    initial_prompt = sys.argv[3] if len(sys.argv) > 3 else None
    
    try:
        output = transcribe(audio_path, model_size, initial_prompt)
        # Kết quả JSON cuối cùng in ra stdout
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
