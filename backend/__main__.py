import sys
import asyncio
import uvicorn
from .config import Settings
from .app import create_app


def main():
    settings = Settings.from_env()
    # Playwright needs asyncio subprocesses on Windows. Avoid uvicorn reload's selector loop.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    app = create_app(settings)
    uvicorn.run(app, host="127.0.0.1", port=settings.port, loop="asyncio", access_log=False)


if __name__ == "__main__":
    main()
