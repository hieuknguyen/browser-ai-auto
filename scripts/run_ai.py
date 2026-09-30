"""Chạy trực tiếp tác vụ AI điều khiển Google Chrome thật từ terminal."""
import asyncio
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from backend.config import Settings
from backend.events import EventBus
from backend.browser import BrowserManager
from backend.ai import AIController
from backend.models import AITaskRequest


async def run_standalone(instruction: str, start_url: str, max_steps: int):
    settings = Settings.from_env()
    if not settings.gemini_api_key:
        print("Lỗi: Chưa cấu hình GEMINI_API_KEY trong file .env!")
        print("Vui lòng mở file .env và nhập GEMINI_API_KEY.")
        return

    bus = EventBus()
    manager = BrowserManager(
        bus,
        headless=False,
        channel=settings.browser_channel,
        executable_path=settings.executable_path,
    )
    ai = AIController(settings, manager, bus)

    queue = bus.subscribe()
    request = AITaskRequest(
        instruction=instruction,
        startUrl=start_url,
        maxSteps=max_steps,
    )

    print(f"\n=======================================================")
    print(f"   ĐANG MỞ GOOGLE CHROME THẬT & BẮT ĐẦU ĐIỀU KHIỂN")
    print(f"=======================================================")
    print(f"Yêu cầu:   {instruction}")
    print(f"Trang mở:  {start_url}")
    print(f"AI API:    {settings.ai_base_url or 'Google Gemini'}")
    print(f"Model:     {settings.gemini_model}")
    print(f"Cửa sổ Chrome thật sẽ bật lên trực tiếp trên màn hình của bạn...\n")

    task = ai.submit(request)
    task_id = task["id"]
    seen_steps = 0

    try:
        while True:
            event = await queue.get()
            if event.get("type") == "ai:task" and event.get("task", {}).get("id") == task_id:
                current_task = event["task"]
                steps = current_task.get("steps", [])
                while seen_steps < len(steps):
                    step = steps[seen_steps]
                    status = step.get("status")
                    icon = "✓" if status == "passed" else "⏳" if status == "running" else "✗"
                    action = step.get("action", "")
                    summary = step.get("summary", "")
                    print(f" [{icon}] Bước {seen_steps + 1}: ({action}) {summary}")
                    if step.get("error"):
                        print(f"     Lỗi bước: {step.get('error')}")
                    seen_steps += 1

                task_status = current_task.get("status")
                if task_status in ("completed", "failed", "cancelled"):
                    print(f"\n-------------------------------------------------------")
                    if task_status == "completed":
                        print(" HOÀN TẤT THÀNH CÔNG!")
                        if current_task.get("answer"):
                            print(f"\nKẾT QUẢ TỪ AI:\n{current_task.get('answer')}")
                    else:
                        print(f" TRẠNG THÁI: {task_status.upper()}")
                        if current_task.get("error"):
                            print(f"\nLỗi: {current_task.get('error')}")
                    print(f"-------------------------------------------------------\n")
                    break
    finally:
        bus.unsubscribe(queue)
        print("Tác vụ kết thúc. Cửa sổ Chrome vẫn mở để bạn xem.")
        print("Nhấn Enter để đóng Chrome hoặc đóng cửa sổ này...")
        try:
            await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
        except Exception:
            pass
        await ai.close()
        await manager.close()


def main():
    if len(sys.argv) < 2:
        print("=======================================================")
        print("  CÔNG CỤ AI ĐIỀU KHIỂN GOOGLE CHROME THẬT")
        print("=======================================================")
        print("Cách dùng:")
        print('  python scripts/run_ai.py "<yêu cầu của bạn>" [URL_bắt_đầu]')
        print("\nVí dụ:")
        print('  python scripts/run_ai.py "tìm kiếm bài hát mới nhất của Sơn Tùng M-TP" https://www.youtube.com/')
        print('  python scripts/run_ai.py "tìm thông tin thời tiết Hà Nội" https://www.google.com/')
        print("=======================================================")
        return

    instruction = sys.argv[1]
    start_url = sys.argv[2] if len(sys.argv) > 2 else "https://www.google.com/"
    max_steps = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    asyncio.run(run_standalone(instruction, start_url, max_steps))


if __name__ == "__main__":
    main()
